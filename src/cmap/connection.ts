import { on } from 'stream';
import { clearTimeout, setTimeout } from 'timers';
import { promisify } from 'util';

import type { BSONSerializeOptions, Document, ObjectId } from '../bson';
import type { AutoEncrypter } from '../client-side-encryption/auto_encrypter';
import {
  CLOSE,
  CLUSTER_TIME_RECEIVED,
  COMMAND_FAILED,
  COMMAND_STARTED,
  COMMAND_SUCCEEDED,
  MESSAGE,
  PINNED,
  UNPINNED
} from '../constants';
import {
  MongoCompatibilityError,
  MongoMissingDependencyError,
  MongoNetworkError,
  MongoNetworkTimeoutError,
  MongoParseError,
  MongoRuntimeError,
  MongoServerError,
  MongoUnexpectedServerResponseError,
  MongoWriteConcernError
} from '../error';
import type { ServerApi, SupportedNodeConnectionOptions } from '../mongo_client';
import { type CancellationToken, TypedEventEmitter } from '../mongo_types';
import type { ReadPreferenceLike } from '../read_preference';
import { applySession, type ClientSession, updateSessionFromResponse } from '../sessions';
import {
  abortable,
  BufferPool,
  calculateDurationInMs,
  type Callback,
  HostAddress,
  maxWireVersion,
  type MongoDBNamespace,
  now,
  uuidV4
} from '../utils';
import type { WriteConcern } from '../write_concern';
import type { AuthContext } from './auth/auth_provider';
import type { MongoCredentials } from './auth/mongo_credentials';
import {
  CommandFailedEvent,
  CommandStartedEvent,
  CommandSucceededEvent
} from './command_monitoring_events';
import {
  OpCompressedRequest,
  OpMsgRequest,
  type OpMsgResponse,
  OpQueryRequest,
  type OpQueryResponse,
  type WriteProtocolMessageType
} from './commands';
import type { Stream } from './connect';
import type { ClientMetadata } from './handshake/client_metadata';
import { MessageStream, type OperationDescription } from './message_stream';
import { StreamDescription, type StreamDescriptionOptions } from './stream_description';
import { decompressResponse } from './wire_protocol/compression';
import { getReadPreference, isSharded } from './wire_protocol/shared';

/** @internal */
const kStream = Symbol('stream');
/** @internal */
const kQueue = Symbol('queue');
/** @internal */
const kMessageStream = Symbol('messageStream');
/** @internal */
const kGeneration = Symbol('generation');
/** @internal */
const kLastUseTime = Symbol('lastUseTime');
/** @internal */
const kClusterTime = Symbol('clusterTime');
/** @internal */
const kDescription = Symbol('description');
/** @internal */
const kHello = Symbol('hello');
/** @internal */
const kAutoEncrypter = Symbol('autoEncrypter');
/** @internal */
const kDelayedTimeoutId = Symbol('delayedTimeoutId');

const INVALID_QUEUE_SIZE = 'Connection internal queue contains more than 1 operation description';

/** @internal */
export interface CommandOptions extends BSONSerializeOptions {
  secondaryOk?: boolean;
  /** Specify read preference if command supports it */
  readPreference?: ReadPreferenceLike;
  monitoring?: boolean;
  socketTimeoutMS?: number;
  /** Session to use for the operation */
  session?: ClientSession;
  documentsReturnedIn?: string;
  noResponse?: boolean;
  omitReadPreference?: boolean;

  // TODO(NODE-2802): Currently the CommandOptions take a property willRetryWrite which is a hint
  // from executeOperation that the txnNum should be applied to this command.
  // Applying a session to a command should happen as part of command construction,
  // most likely in the CommandOperation#executeCommand method, where we have access to
  // the details we need to determine if a txnNum should also be applied.
  willRetryWrite?: boolean;

  writeConcern?: WriteConcern;
}

/** @public */
export interface ProxyOptions {
  proxyHost?: string;
  proxyPort?: number;
  proxyUsername?: string;
  proxyPassword?: string;
}

/** @public */
export interface ConnectionOptions
  extends SupportedNodeConnectionOptions,
    StreamDescriptionOptions,
    ProxyOptions {
  // Internal creation info
  id: number | '<monitor>';
  generation: number;
  hostAddress: HostAddress;
  /** @internal */
  autoEncrypter?: AutoEncrypter;
  serverApi?: ServerApi;
  monitorCommands: boolean;
  /** @internal */
  connectionType?: typeof Connection;
  credentials?: MongoCredentials;
  connectTimeoutMS?: number;
  tls: boolean;
  noDelay?: boolean;
  socketTimeoutMS?: number;
  cancellationToken?: CancellationToken;
  metadata: ClientMetadata;
}

/** @internal */
export interface DestroyOptions {
  /** Force the destruction. */
  force: boolean;
}

/** @public */
export type ConnectionEvents = {
  commandStarted(event: CommandStartedEvent): void;
  commandSucceeded(event: CommandSucceededEvent): void;
  commandFailed(event: CommandFailedEvent): void;
  clusterTimeReceived(clusterTime: Document): void;
  close(): void;
  message(message: any): void;
  pinned(pinType: string): void;
  unpinned(pinType: string): void;
};

/** @internal */
export class Connection extends TypedEventEmitter<ConnectionEvents> {
  id: number | '<monitor>';
  address: string;
  socketTimeoutMS: number;
  monitorCommands: boolean;
  /** Indicates that the connection (including underlying TCP socket) has been closed. */
  closed: boolean;
  lastHelloMS?: number;
  serverApi?: ServerApi;
  helloOk?: boolean;
  /** @internal */
  authContext?: AuthContext;

  /**@internal */
  [kDelayedTimeoutId]: NodeJS.Timeout | null;
  /** @internal */
  [kDescription]: StreamDescription;
  /** @internal */
  [kGeneration]: number;
  /** @internal */
  [kLastUseTime]: number;
  /** @internal */
  [kQueue]: Map<number, OperationDescription>;
  /** @internal */
  [kMessageStream]: MessageStream;
  /** @internal */
  [kStream]: Stream;
  /** @internal */
  [kHello]: Document | null;
  /** @internal */
  [kClusterTime]: Document | null;

  /** @event */
  static readonly COMMAND_STARTED = COMMAND_STARTED;
  /** @event */
  static readonly COMMAND_SUCCEEDED = COMMAND_SUCCEEDED;
  /** @event */
  static readonly COMMAND_FAILED = COMMAND_FAILED;
  /** @event */
  static readonly CLUSTER_TIME_RECEIVED = CLUSTER_TIME_RECEIVED;
  /** @event */
  static readonly CLOSE = CLOSE;
  /** @event */
  static readonly MESSAGE = MESSAGE;
  /** @event */
  static readonly PINNED = PINNED;
  /** @event */
  static readonly UNPINNED = UNPINNED;

  constructor(stream: Stream, options: ConnectionOptions) {
    super();

    this.id = options.id;
    this.address = streamIdentifier(stream, options);
    this.socketTimeoutMS = options.socketTimeoutMS ?? 0;
    this.monitorCommands = options.monitorCommands;
    this.serverApi = options.serverApi;
    this.closed = false;
    this[kHello] = null;
    this[kClusterTime] = null;

    this[kDescription] = new StreamDescription(this.address, options);
    this[kGeneration] = options.generation;
    this[kLastUseTime] = now();

    // setup parser stream and message handling
    this[kQueue] = new Map();
    this[kMessageStream] = new MessageStream({
      ...options,
      maxBsonMessageSize: this.hello?.maxBsonMessageSize
    });
    this[kStream] = stream;

    this[kDelayedTimeoutId] = null;

    this[kMessageStream].on('message', message => this.onMessage(message));
    this[kMessageStream].on('error', error => this.onError(error));
    this[kStream].on('close', () => this.onClose());
    this[kStream].on('timeout', () => this.onTimeout());
    this[kStream].on('error', () => {
      /* ignore errors, listen to `close` instead */
    });

    // hook the message stream up to the passed in stream
    this[kStream].pipe(this[kMessageStream]);
    this[kMessageStream].pipe(this[kStream]);
  }

  // This whole class is temporary,
  // Need to move this to be defined on the prototype for spying.
  async commandAsync(ns: MongoDBNamespace, cmd: Document, opt?: CommandOptions) {
    return promisify(this.command.bind(this))(ns, cmd, opt);
  }

  get description(): StreamDescription {
    return this[kDescription];
  }

  get hello(): Document | null {
    return this[kHello];
  }

  // the `connect` method stores the result of the handshake hello on the connection
  set hello(response: Document | null) {
    this[kDescription].receiveResponse(response);
    this[kDescription] = Object.freeze(this[kDescription]);

    // TODO: remove this, and only use the `StreamDescription` in the future
    this[kHello] = response;
  }

  // Set the whether the message stream is for a monitoring connection.
  set isMonitoringConnection(value: boolean) {
    this[kMessageStream].isMonitoringConnection = value;
  }

  get isMonitoringConnection(): boolean {
    return this[kMessageStream].isMonitoringConnection;
  }

  get serviceId(): ObjectId | undefined {
    return this.hello?.serviceId;
  }

  get loadBalanced(): boolean {
    return this.description.loadBalanced;
  }

  get generation(): number {
    return this[kGeneration] || 0;
  }

  set generation(generation: number) {
    this[kGeneration] = generation;
  }

  get idleTime(): number {
    return calculateDurationInMs(this[kLastUseTime]);
  }

  get clusterTime(): Document | null {
    return this[kClusterTime];
  }

  get stream(): Stream {
    return this[kStream];
  }

  markAvailable(): void {
    this[kLastUseTime] = now();
  }

  onError(error: Error) {
    this.cleanup(true, error);
  }

  onClose() {
    const message = `connection ${this.id} to ${this.address} closed`;
    this.cleanup(true, new MongoNetworkError(message));
  }

  onTimeout() {
    this[kDelayedTimeoutId] = setTimeout(() => {
      const message = `connection ${this.id} to ${this.address} timed out`;
      const beforeHandshake = this.hello == null;
      this.cleanup(true, new MongoNetworkTimeoutError(message, { beforeHandshake }));
    }, 1).unref(); // No need for this timer to hold the event loop open
  }

  onMessage(message: OpMsgResponse | OpQueryResponse) {
    const delayedTimeoutId = this[kDelayedTimeoutId];
    if (delayedTimeoutId != null) {
      clearTimeout(delayedTimeoutId);
      this[kDelayedTimeoutId] = null;
    }

    const socketTimeoutMS = this[kStream].timeout ?? 0;
    this[kStream].setTimeout(0);

    // always emit the message, in case we are streaming
    this.emit('message', message);
    let operationDescription = this[kQueue].get(message.responseTo);

    if (!operationDescription && this.isMonitoringConnection) {
      // This is how we recover when the initial hello's requestId is not
      // the responseTo when hello responses have been skipped:

      // First check if the map is of invalid size
      if (this[kQueue].size > 1) {
        this.cleanup(true, new MongoRuntimeError(INVALID_QUEUE_SIZE));
      } else {
        // Get the first orphaned operation description.
        const entry = this[kQueue].entries().next();
        if (entry.value != null) {
          const [requestId, orphaned]: [number, OperationDescription] = entry.value;
          // If the orphaned operation description exists then set it.
          operationDescription = orphaned;
          // Remove the entry with the bad request id from the queue.
          this[kQueue].delete(requestId);
        }
      }
    }

    if (!operationDescription) {
      return;
    }

    const callback = operationDescription.cb;

    // SERVER-45775: For exhaust responses we should be able to use the same requestId to
    // track response, however the server currently synthetically produces remote requests
    // making the `responseTo` change on each response
    this[kQueue].delete(message.responseTo);
    if ('moreToCome' in message && message.moreToCome) {
      // If the operation description check above does find an orphaned
      // description and sets the operationDescription then this line will put one
      // back in the queue with the correct requestId and will resolve not being able
      // to find the next one via the responseTo of the next streaming hello.
      this[kQueue].set(message.requestId, operationDescription);
      this[kStream].setTimeout(socketTimeoutMS);
    }

    try {
      // Pass in the entire description because it has BSON parsing options
      message.parse(operationDescription);
    } catch (err) {
      // If this error is generated by our own code, it will already have the correct class applied
      // if it is not, then it is coming from a catastrophic data parse failure or the BSON library
      // in either case, it should not be wrapped
      callback(err);
      return;
    }

    if (message.documents[0]) {
      const document: Document = message.documents[0];
      const session = operationDescription.session;
      if (session) {
        updateSessionFromResponse(session, document);
      }

      if (document.$clusterTime) {
        this[kClusterTime] = document.$clusterTime;
        this.emit(Connection.CLUSTER_TIME_RECEIVED, document.$clusterTime);
      }

      if (document.writeConcernError) {
        callback(new MongoWriteConcernError(document.writeConcernError, document), document);
        return;
      }

      if (document.ok === 0 || document.$err || document.errmsg || document.code) {
        callback(new MongoServerError(document));
        return;
      }
    }

    callback(undefined, message.documents[0]);
  }

  destroy(options: DestroyOptions, callback?: Callback): void {
    if (this.closed) {
      process.nextTick(() => callback?.());
      return;
    }
    if (typeof callback === 'function') {
      this.once('close', () => process.nextTick(() => callback()));
    }

    // load balanced mode requires that these listeners remain on the connection
    // after cleanup on timeouts, errors or close so we remove them before calling
    // cleanup.
    this.removeAllListeners(Connection.PINNED);
    this.removeAllListeners(Connection.UNPINNED);
    const message = `connection ${this.id} to ${this.address} closed`;
    this.cleanup(options.force, new MongoNetworkError(message));
  }

  /**
   * A method that cleans up the connection.  When `force` is true, this method
   * forcibly destroys the socket.
   *
   * If an error is provided, any in-flight operations will be closed with the error.
   *
   * This method does nothing if the connection is already closed.
   */
  private cleanup(force: boolean, error?: Error): void {
    if (this.closed) {
      return;
    }

    this.closed = true;

    const completeCleanup = () => {
      for (const op of this[kQueue].values()) {
        op.cb(error);
      }

      this[kQueue].clear();

      this.emit(Connection.CLOSE);
    };

    this[kStream].removeAllListeners();
    this[kMessageStream].removeAllListeners();

    this[kMessageStream].destroy();

    if (force) {
      this[kStream].destroy();
      completeCleanup();
      return;
    }

    if (!this[kStream].writableEnded) {
      this[kStream].end(() => {
        this[kStream].destroy();
        completeCleanup();
      });
    } else {
      completeCleanup();
    }
  }

  command(
    ns: MongoDBNamespace,
    command: Document,
    options: CommandOptions | undefined,
    callback: Callback
  ): void {
    let cmd = { ...command };

    const readPreference = getReadPreference(options);
    const shouldUseOpMsg = supportsOpMsg(this);
    const session = options?.session;

    let clusterTime = this.clusterTime;

    if (this.serverApi) {
      const { version, strict, deprecationErrors } = this.serverApi;
      cmd.apiVersion = version;
      if (strict != null) cmd.apiStrict = strict;
      if (deprecationErrors != null) cmd.apiDeprecationErrors = deprecationErrors;
    }

    if (hasSessionSupport(this) && session) {
      if (
        session.clusterTime &&
        clusterTime &&
        session.clusterTime.clusterTime.greaterThan(clusterTime.clusterTime)
      ) {
        clusterTime = session.clusterTime;
      }

      const err = applySession(session, cmd, options);
      if (err) {
        return callback(err);
      }
    } else if (session?.explicit) {
      return callback(new MongoCompatibilityError('Current topology does not support sessions'));
    }

    // if we have a known cluster time, gossip it
    if (clusterTime) {
      cmd.$clusterTime = clusterTime;
    }

    if (isSharded(this) && !shouldUseOpMsg && readPreference && readPreference.mode !== 'primary') {
      cmd = {
        $query: cmd,
        $readPreference: readPreference.toJSON()
      };
    }

    const commandOptions: Document = Object.assign(
      {
        numberToSkip: 0,
        numberToReturn: -1,
        checkKeys: false,
        // This value is not overridable
        secondaryOk: readPreference.secondaryOk()
      },
      options
    );

    const message = shouldUseOpMsg
      ? new OpMsgRequest(ns.db, cmd, commandOptions)
      : new OpQueryRequest(ns.db, cmd, commandOptions);

    try {
      write(this, message, commandOptions, callback);
    } catch (err) {
      callback(err);
    }
  }

  exhaustCommand(
    ns: MongoDBNamespace,
    command: Document,
    options: CommandOptions | undefined,
    replyListener: Callback
  ) {
    return this.command(ns, command, options, replyListener);
  }
}

/** @internal */
export class CryptoConnection extends Connection {
  /** @internal */
  [kAutoEncrypter]?: AutoEncrypter;

  constructor(stream: Stream, options: ConnectionOptions) {
    super(stream, options);
    this[kAutoEncrypter] = options.autoEncrypter;
  }

  /** @internal @override */
  override command(
    ns: MongoDBNamespace,
    cmd: Document,
    options: CommandOptions,
    callback: Callback
  ): void {
    const autoEncrypter = this[kAutoEncrypter];
    if (!autoEncrypter) {
      return callback(new MongoMissingDependencyError('No AutoEncrypter available for encryption'));
    }

    const serverWireVersion = maxWireVersion(this);
    if (serverWireVersion === 0) {
      // This means the initial handshake hasn't happened yet
      return super.command(ns, cmd, options, callback);
    }

    if (serverWireVersion < 8) {
      callback(
        new MongoCompatibilityError('Auto-encryption requires a minimum MongoDB version of 4.2')
      );
      return;
    }

    // Save sort or indexKeys based on the command being run
    // the encrypt API serializes our JS objects to BSON to pass to the native code layer
    // and then deserializes the encrypted result, the protocol level components
    // of the command (ex. sort) are then converted to JS objects potentially losing
    // import key order information. These fields are never encrypted so we can save the values
    // from before the encryption and replace them after encryption has been performed
    const sort: Map<string, number> | null = cmd.find || cmd.findAndModify ? cmd.sort : null;
    const indexKeys: Map<string, number>[] | null = cmd.createIndexes
      ? cmd.indexes.map((index: { key: Map<string, number> }) => index.key)
      : null;

    autoEncrypter.encrypt(ns.toString(), cmd, options).then(
      encrypted => {
        // Replace the saved values
        if (sort != null && (cmd.find || cmd.findAndModify)) {
          encrypted.sort = sort;
        }
        if (indexKeys != null && cmd.createIndexes) {
          for (const [offset, index] of indexKeys.entries()) {
            // @ts-expect-error `encrypted` is a generic "command", but we've narrowed for only `createIndexes` commands here
            encrypted.indexes[offset].key = index;
          }
        }

        super.command(ns, encrypted, options, (err, response) => {
          if (err || response == null) {
            callback(err, response);
            return;
          }

          autoEncrypter.decrypt(response, options).then(
            res => callback(undefined, res),
            err => callback(err)
          );
        });
      },
      err => {
        if (err) {
          callback(err, null);
        }
      }
    );
  }
}

/** @internal */
export function hasSessionSupport(conn: Connection): boolean {
  const description = conn.description;
  return description.logicalSessionTimeoutMinutes != null;
}

function supportsOpMsg(conn: Connection) {
  const description = conn.description;
  if (description == null) {
    return false;
  }

  return maxWireVersion(conn) >= 6 && !description.__nodejs_mock_server__;
}

function streamIdentifier(stream: Stream, options: ConnectionOptions): string {
  if (options.proxyHost) {
    // If proxy options are specified, the properties of `stream` itself
    // will not accurately reflect what endpoint this is connected to.
    return options.hostAddress.toString();
  }

  const { remoteAddress, remotePort } = stream;
  if (typeof remoteAddress === 'string' && typeof remotePort === 'number') {
    return HostAddress.fromHostPort(remoteAddress, remotePort).toString();
  }

  return uuidV4().toString('hex');
}

function write(
  conn: Connection,
  command: WriteProtocolMessageType,
  options: CommandOptions,
  callback: Callback
) {
  options = options ?? {};
  const operationDescription: OperationDescription = {
    requestId: command.requestId,
    cb: callback,
    session: options.session,
    noResponse: typeof options.noResponse === 'boolean' ? options.noResponse : false,
    documentsReturnedIn: options.documentsReturnedIn,

    // for BSON parsing
    useBigInt64: typeof options.useBigInt64 === 'boolean' ? options.useBigInt64 : false,
    promoteLongs: typeof options.promoteLongs === 'boolean' ? options.promoteLongs : true,
    promoteValues: typeof options.promoteValues === 'boolean' ? options.promoteValues : true,
    promoteBuffers: typeof options.promoteBuffers === 'boolean' ? options.promoteBuffers : false,
    bsonRegExp: typeof options.bsonRegExp === 'boolean' ? options.bsonRegExp : false,
    enableUtf8Validation:
      typeof options.enableUtf8Validation === 'boolean' ? options.enableUtf8Validation : true,
    raw: typeof options.raw === 'boolean' ? options.raw : false,
    started: 0
  };

  if (conn[kDescription] && conn[kDescription].compressor) {
    operationDescription.agreedCompressor = conn[kDescription].compressor;

    if (conn[kDescription].zlibCompressionLevel) {
      operationDescription.zlibCompressionLevel = conn[kDescription].zlibCompressionLevel;
    }
  }

  if (typeof options.socketTimeoutMS === 'number') {
    conn[kStream].setTimeout(options.socketTimeoutMS);
  } else if (conn.socketTimeoutMS !== 0) {
    conn[kStream].setTimeout(conn.socketTimeoutMS);
  }

  // if command monitoring is enabled we need to modify the callback here
  if (conn.monitorCommands) {
    conn.emit(Connection.COMMAND_STARTED, new CommandStartedEvent(conn, command));

    operationDescription.started = now();
    operationDescription.cb = (err, reply) => {
      // Command monitoring spec states that if ok is 1, then we must always emit
      // a command succeeded event, even if there's an error. Write concern errors
      // will have an ok: 1 in their reply.
      if (err && reply?.ok !== 1) {
        conn.emit(
          Connection.COMMAND_FAILED,
          new CommandFailedEvent(conn, command, err, operationDescription.started)
        );
      } else {
        if (reply && (reply.ok === 0 || reply.$err)) {
          conn.emit(
            Connection.COMMAND_FAILED,
            new CommandFailedEvent(conn, command, reply, operationDescription.started)
          );
        } else {
          conn.emit(
            Connection.COMMAND_SUCCEEDED,
            new CommandSucceededEvent(conn, command, reply, operationDescription.started)
          );
        }
      }

      if (typeof callback === 'function') {
        // Since we're passing through the reply with the write concern error now, we
        // need it not to be provided to the original callback in this case so
        // retryability does not get tricked into thinking the command actually
        // succeeded.
        callback(err, err instanceof MongoWriteConcernError ? undefined : reply);
      }
    };
  }

  if (!operationDescription.noResponse) {
    conn[kQueue].set(operationDescription.requestId, operationDescription);
  }

  try {
    conn[kMessageStream].writeCommand(command, operationDescription);
  } catch (e) {
    if (!operationDescription.noResponse) {
      conn[kQueue].delete(operationDescription.requestId);
      operationDescription.cb(e);
      return;
    }
  }

  if (operationDescription.noResponse) {
    operationDescription.cb();
  }
}

/** in-progress connection layer */

/** @internal */
export class ModernConnection extends TypedEventEmitter<ConnectionEvents> {
  id: number | '<monitor>';
  address: string;
  socketTimeoutMS: number;
  monitorCommands: boolean;
  lastHelloMS?: number;
  serverApi?: ServerApi;
  helloOk?: boolean;
  /** @internal */
  authContext?: AuthContext;

  /**@internal */
  delayedTimeoutId: NodeJS.Timeout | null = null;
  /** @internal */
  [kDescription]: StreamDescription;
  /** @internal */
  [kGeneration]: number;
  /** @internal */
  [kLastUseTime]: number;
  /** @internal */
  socket: Stream;
  controller: AbortController;
  /** @internal */
  [kHello]: Document | null;
  /** @internal */
  [kClusterTime]: Document | null;

  /** @event */
  static readonly COMMAND_STARTED = COMMAND_STARTED;
  /** @event */
  static readonly COMMAND_SUCCEEDED = COMMAND_SUCCEEDED;
  /** @event */
  static readonly COMMAND_FAILED = COMMAND_FAILED;
  /** @event */
  static readonly CLUSTER_TIME_RECEIVED = CLUSTER_TIME_RECEIVED;
  /** @event */
  static readonly CLOSE = CLOSE;
  /** @event */
  static readonly MESSAGE = MESSAGE;
  /** @event */
  static readonly PINNED = PINNED;
  /** @event */
  static readonly UNPINNED = UNPINNED;

  constructor(stream: Stream, options: ConnectionOptions) {
    super();

    this.id = options.id;
    this.address = streamIdentifier(stream, options);
    this.socketTimeoutMS = options.socketTimeoutMS ?? 0;
    this.monitorCommands = options.monitorCommands;
    this.serverApi = options.serverApi;
    this[kHello] = null;
    this[kClusterTime] = null;

    this[kDescription] = new StreamDescription(this.address, options);
    this[kGeneration] = options.generation;
    this[kLastUseTime] = now();

    this.socket = stream;
    this.controller = new AbortController();
    this.socket.on('error', this.onError.bind(this));
    this.socket.on('close', this.onClose.bind(this));
    this.socket.on('timeout', this.onTimeout.bind(this));
  }

  async commandAsync(...args: Parameters<typeof this.command>) {
    return this.command(...args);
  }

  /** Indicates that the connection (including underlying TCP socket) has been closed. */
  get closed(): boolean {
    return this.controller.signal.aborted;
  }

  get description(): StreamDescription {
    return this[kDescription];
  }

  get hello(): Document | null {
    return this[kHello];
  }

  // the `connect` method stores the result of the handshake hello on the connection
  set hello(response: Document | null) {
    this[kDescription].receiveResponse(response);
    this[kDescription] = Object.freeze(this[kDescription]);

    // TODO: remove this, and only use the `StreamDescription` in the future
    this[kHello] = response;
  }

  get serviceId(): ObjectId | undefined {
    return this.hello?.serviceId;
  }

  get loadBalanced(): boolean {
    return this.description.loadBalanced;
  }

  get generation(): number {
    return this[kGeneration] || 0;
  }

  set generation(generation: number) {
    this[kGeneration] = generation;
  }

  get idleTime(): number {
    return calculateDurationInMs(this[kLastUseTime]);
  }

  get clusterTime(): Document | null {
    return this[kClusterTime];
  }

  get stream(): Stream {
    return this.socket;
  }

  get hasSessionSupport(): boolean {
    return this.description.logicalSessionTimeoutMinutes != null;
  }

  get supportsOpMsg(): boolean {
    return (
      this.description != null &&
      maxWireVersion(this as any as Connection) >= 6 &&
      !this.description.__nodejs_mock_server__
    );
  }

  markAvailable(): void {
    this[kLastUseTime] = now();
  }

  onError(error?: Error) {
    this.cleanup(error);
  }

  onClose() {
    const message = `connection ${this.id} to ${this.address} closed`;
    this.cleanup(new MongoNetworkError(message));
  }

  onTimeout() {
    this.delayedTimeoutId = setTimeout(() => {
      const message = `connection ${this.id} to ${this.address} timed out`;
      const beforeHandshake = this.hello == null;
      this.cleanup(new MongoNetworkTimeoutError(message, { beforeHandshake }));
    }, 1).unref(); // No need for this timer to hold the event loop open
  }

  destroy(options: DestroyOptions, callback?: Callback): void {
    if (this.closed) {
      if (typeof callback === 'function') process.nextTick(callback);
      return;
    }
    if (typeof callback === 'function') {
      this.once('close', () => process.nextTick(() => callback()));
    }

    // load balanced mode requires that these listeners remain on the connection
    // after cleanup on timeouts, errors or close so we remove them before calling
    // cleanup.
    this.removeAllListeners(Connection.PINNED);
    this.removeAllListeners(Connection.UNPINNED);
    const message = `connection ${this.id} to ${this.address} closed`;
    this.cleanup(new MongoNetworkError(message));
  }

  /**
   * A method that cleans up the connection.  When `force` is true, this method
   * forcibly destroys the socket.
   *
   * If an error is provided, any in-flight operations will be closed with the error.
   *
   * This method does nothing if the connection is already closed.
   */
  private cleanup(error?: Error): void {
    if (this.closed) {
      return;
    }

    this.socket.destroy();
    this.controller.abort(error);
    this.emit(Connection.CLOSE);
  }

  private prepareCommand(db: string, command: Document, options: CommandOptions) {
    let cmd = { ...command };

    const readPreference = getReadPreference(options);
    const session = options?.session;

    let clusterTime = this.clusterTime;

    if (this.serverApi) {
      const { version, strict, deprecationErrors } = this.serverApi;
      cmd.apiVersion = version;
      if (strict != null) cmd.apiStrict = strict;
      if (deprecationErrors != null) cmd.apiDeprecationErrors = deprecationErrors;
    }

    if (this.hasSessionSupport && session) {
      if (
        session.clusterTime &&
        clusterTime &&
        session.clusterTime.clusterTime.greaterThan(clusterTime.clusterTime)
      ) {
        clusterTime = session.clusterTime;
      }

      const sessionError = applySession(session, cmd, options);
      if (sessionError) throw sessionError;
    } else if (session?.explicit) {
      throw new MongoCompatibilityError('Current topology does not support sessions');
    }

    // if we have a known cluster time, gossip it
    if (clusterTime) {
      cmd.$clusterTime = clusterTime;
    }

    if (
      // @ts-expect-error ModernConnections cannot be passed as connections
      isSharded(this) &&
      !this.supportsOpMsg &&
      readPreference &&
      readPreference.mode !== 'primary'
    ) {
      cmd = {
        $query: cmd,
        $readPreference: readPreference.toJSON()
      };
    }

    const commandOptions = {
      numberToSkip: 0,
      numberToReturn: -1,
      checkKeys: false,
      // This value is not overridable
      secondaryOk: readPreference.secondaryOk(),
      ...options,
      readPreference // ensure we pass in ReadPreference instance
    };

    const message = this.supportsOpMsg
      ? new OpMsgRequest(db, cmd, commandOptions)
      : new OpQueryRequest(db, cmd, commandOptions);

    return message;
  }

  private async *sendWire(message: WriteProtocolMessageType, options: CommandOptions) {
    this.controller.signal.throwIfAborted();

    if (typeof options.socketTimeoutMS === 'number') {
      this.socket.setTimeout(options.socketTimeoutMS);
    } else if (this.socketTimeoutMS !== 0) {
      this.socket.setTimeout(this.socketTimeoutMS);
    }

    try {
      await writeCommand(this, message, {
        agreedCompressor: this.description.compressor ?? 'none',
        zlibCompressionLevel: this.description.zlibCompressionLevel,
        signal: this.controller.signal
      });

      // TODO(NODE-5770): Replace controller to avoid boundless 'abort' listeners
      this.controller = new AbortController();

      if (options.noResponse) {
        yield { ok: 1 };
        return;
      }

      this.controller.signal.throwIfAborted();

      for await (const response of readMany(this, { signal: this.controller.signal })) {
        this.socket.setTimeout(0);
        response.parse(options);

        const [document] = response.documents;

        if (!Buffer.isBuffer(document)) {
          const { session } = options;
          if (session) {
            updateSessionFromResponse(session, document);
          }

          if (document.$clusterTime) {
            this[kClusterTime] = document.$clusterTime;
            this.emit(Connection.CLUSTER_TIME_RECEIVED, document.$clusterTime);
          }
        }

        // TODO(NODE-5770): Replace controller to avoid boundless 'abort' listeners
        this.controller = new AbortController();

        yield document;
        this.controller.signal.throwIfAborted();

        if (typeof options.socketTimeoutMS === 'number') {
          this.socket.setTimeout(options.socketTimeoutMS);
        } else if (this.socketTimeoutMS !== 0) {
          this.socket.setTimeout(this.socketTimeoutMS);
        }
      }
    } finally {
      this.socket.setTimeout(0);
    }
  }

  async *sendCommand(ns: MongoDBNamespace, command: Document, options: CommandOptions = {}) {
    const message = this.prepareCommand(ns.db, command, options);

    let started = 0;
    if (this.monitorCommands) {
      started = now();
      this.emit(
        ModernConnection.COMMAND_STARTED,
        new CommandStartedEvent(this as unknown as Connection, message)
      );
    }

    let document;
    try {
      this.controller.signal.throwIfAborted();
      for await (document of this.sendWire(message, options)) {
        if (!Buffer.isBuffer(document) && document.writeConcernError) {
          throw new MongoWriteConcernError(document.writeConcernError, document);
        }

        if (
          !Buffer.isBuffer(document) &&
          (document.ok === 0 || document.$err || document.errmsg || document.code)
        ) {
          throw new MongoServerError(document);
        }

        if (this.monitorCommands) {
          this.emit(
            ModernConnection.COMMAND_SUCCEEDED,
            new CommandSucceededEvent(
              this as unknown as Connection,
              message,
              options.noResponse ? undefined : document,
              started
            )
          );
        }

        yield document;
        this.controller.signal.throwIfAborted();
      }
    } catch (error) {
      if (this.monitorCommands) {
        error.name === 'MongoWriteConcernError'
          ? this.emit(
              ModernConnection.COMMAND_SUCCEEDED,
              new CommandSucceededEvent(
                this as unknown as Connection,
                message,
                options.noResponse ? undefined : document,
                started
              )
            )
          : this.emit(
              ModernConnection.COMMAND_FAILED,
              new CommandFailedEvent(this as unknown as Connection, message, error, started)
            );
      }
      throw error;
    }
  }

  async command(
    ns: MongoDBNamespace,
    command: Document,
    options: CommandOptions = {}
  ): Promise<Document> {
    this.controller.signal.throwIfAborted();
    for await (const document of this.sendCommand(ns, command, options)) {
      return document;
    }
    throw new MongoUnexpectedServerResponseError('Unable to get response from server');
  }

  exhaustCommand(
    ns: MongoDBNamespace,
    command: Document,
    options: CommandOptions,
    replyListener: Callback
  ) {
    const exhaustLoop = async () => {
      this.controller.signal.throwIfAborted();
      for await (const reply of this.sendCommand(ns, command, options)) {
        replyListener(undefined, reply);
        this.controller.signal.throwIfAborted();
      }
      throw new MongoUnexpectedServerResponseError('Server ended moreToCome unexpectedly');
    };
    exhaustLoop().catch(replyListener);
  }
}

const kDefaultMaxBsonMessageSize = 1024 * 1024 * 16 * 4;

/**
 * @internal
 *
 * This helper reads chucks of data out of a socket and buffers them until it has received a
 * full wire protocol message.
 *
 * By itself, produces an infinite async generator of wire protocol messages and consumers must end
 * the stream by calling `return` on the generator.
 *
 * Note that `for-await` loops call `return` automatically when the loop is exited.
 */
export async function* readWireProtocolMessages(
  connection: ModernConnection,
  { signal }: { signal?: AbortSignal } = {}
): AsyncGenerator<Buffer> {
  const bufferPool = new BufferPool();
  const maxBsonMessageSize = connection.hello?.maxBsonMessageSize ?? kDefaultMaxBsonMessageSize;
  for await (const [chunk] of on(connection.socket, 'data', { signal })) {
    if (connection.delayedTimeoutId) {
      clearTimeout(connection.delayedTimeoutId);
      connection.delayedTimeoutId = null;
    }

    bufferPool.append(chunk);
    const sizeOfMessage = bufferPool.getInt32();

    if (sizeOfMessage == null) {
      continue;
    }

    if (sizeOfMessage < 0) {
      throw new MongoParseError(`Invalid message size: ${sizeOfMessage}`);
    }

    if (sizeOfMessage > maxBsonMessageSize) {
      throw new MongoParseError(
        `Invalid message size: ${sizeOfMessage}, max allowed: ${maxBsonMessageSize}`
      );
    }

    if (sizeOfMessage > bufferPool.length) {
      continue;
    }

    yield bufferPool.read(sizeOfMessage);
  }
}

/**
 * @internal
 *
 * Writes an OP_MSG or OP_QUERY request to the socket, optionally compressing the command. This method
 * waits until the socket's buffer has emptied (the Nodejs socket `drain` event has fired).
 */
export async function writeCommand(
  connection: ModernConnection,
  command: WriteProtocolMessageType,
  options: Partial<Pick<OperationDescription, 'agreedCompressor' | 'zlibCompressionLevel'>> & {
    signal?: AbortSignal;
  }
): Promise<void> {
  const finalCommand =
    options.agreedCompressor === 'none' || !OpCompressedRequest.canCompress(command)
      ? command
      : new OpCompressedRequest(command, {
          agreedCompressor: options.agreedCompressor ?? 'none',
          zlibCompressionLevel: options.zlibCompressionLevel ?? 0
        });

  const buffer = Buffer.concat(await finalCommand.toBin());

  const socketWriteFn = promisify(connection.socket.write.bind(connection.socket));

  return abortable(socketWriteFn(buffer), options);
}

/**
 * @internal
 *
 * Returns an async generator that yields full wire protocol messages from the underlying socket.  This function
 * yields messages until `moreToCome` is false or not present in a response, or the caller cancels the request
 * by calling `return` on the generator.
 *
 * Note that `for-await` loops call `return` automatically when the loop is exited.
 */
export async function* readMany(
  connection: ModernConnection,
  options: { signal?: AbortSignal } = {}
): AsyncGenerator<OpMsgResponse | OpQueryResponse> {
  for await (const message of readWireProtocolMessages(connection, options)) {
    const response = await decompressResponse(message);
    yield response;

    if (!response.moreToCome) {
      return;
    }
  }
}

/**
 * @internal
 *
 * Reads a single wire protocol message out of a connection.
 */
export async function read(
  connection: ModernConnection,
  options: { signal?: AbortSignal } = {}
): Promise<OpMsgResponse | OpQueryResponse> {
  for await (const value of readMany(connection, options)) {
    return value;
  }

  throw new MongoRuntimeError('unable to read message off of connection');
}
