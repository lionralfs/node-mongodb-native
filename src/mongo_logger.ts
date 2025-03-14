import { type Document, EJSON, type EJSONOptions } from 'bson';
import type { Writable } from 'stream';
import { inspect } from 'util';

import type {
  CommandFailedEvent,
  CommandStartedEvent,
  CommandSucceededEvent
} from './cmap/command_monitoring_events';
import type {
  ConnectionCheckedInEvent,
  ConnectionCheckedOutEvent,
  ConnectionCheckOutFailedEvent,
  ConnectionCheckOutStartedEvent,
  ConnectionClosedEvent,
  ConnectionCreatedEvent,
  ConnectionPoolClearedEvent,
  ConnectionPoolClosedEvent,
  ConnectionPoolCreatedEvent,
  ConnectionPoolMonitoringEvent,
  ConnectionPoolReadyEvent,
  ConnectionReadyEvent
} from './cmap/connection_pool_events';
import {
  COMMAND_FAILED,
  COMMAND_STARTED,
  COMMAND_SUCCEEDED,
  CONNECTION_CHECK_OUT_FAILED,
  CONNECTION_CHECK_OUT_STARTED,
  CONNECTION_CHECKED_IN,
  CONNECTION_CHECKED_OUT,
  CONNECTION_CLOSED,
  CONNECTION_CREATED,
  CONNECTION_POOL_CLEARED,
  CONNECTION_POOL_CLOSED,
  CONNECTION_POOL_CREATED,
  CONNECTION_POOL_READY,
  CONNECTION_READY,
  SERVER_CLOSED,
  SERVER_HEARTBEAT_FAILED,
  SERVER_HEARTBEAT_STARTED,
  SERVER_HEARTBEAT_SUCCEEDED,
  SERVER_OPENING,
  TOPOLOGY_CLOSED,
  TOPOLOGY_DESCRIPTION_CHANGED,
  TOPOLOGY_OPENING
} from './constants';
import type {
  ServerClosedEvent,
  ServerOpeningEvent,
  TopologyClosedEvent,
  TopologyDescriptionChangedEvent,
  TopologyOpeningEvent
} from './sdam/events';
import { HostAddress, parseUnsignedInteger } from './utils';

/** @internal */
export const SeverityLevel = Object.freeze({
  EMERGENCY: 'emergency',
  ALERT: 'alert',
  CRITICAL: 'critical',
  ERROR: 'error',
  WARNING: 'warn',
  NOTICE: 'notice',
  INFORMATIONAL: 'info',
  DEBUG: 'debug',
  TRACE: 'trace',
  OFF: 'off'
} as const);

/** @internal */
export const DEFAULT_MAX_DOCUMENT_LENGTH = 1000;
/** @internal */
export type SeverityLevel = (typeof SeverityLevel)[keyof typeof SeverityLevel];

/** @internal */
class SeverityLevelMap extends Map<SeverityLevel | number, SeverityLevel | number> {
  constructor(entries: [SeverityLevel | number, SeverityLevel | number][]) {
    const newEntries: [number | SeverityLevel, SeverityLevel | number][] = [];
    for (const [level, value] of entries) {
      newEntries.push([value, level]);
    }

    newEntries.push(...entries);
    super(newEntries);
  }

  getNumericSeverityLevel(severity: SeverityLevel): number {
    return this.get(severity) as number;
  }

  getSeverityLevelName(level: number): SeverityLevel | undefined {
    return this.get(level) as SeverityLevel | undefined;
  }
}

/** @internal */
export const SEVERITY_LEVEL_MAP = new SeverityLevelMap([
  [SeverityLevel.OFF, -Infinity],
  [SeverityLevel.EMERGENCY, 0],
  [SeverityLevel.ALERT, 1],
  [SeverityLevel.CRITICAL, 2],
  [SeverityLevel.ERROR, 3],
  [SeverityLevel.WARNING, 4],
  [SeverityLevel.NOTICE, 5],
  [SeverityLevel.INFORMATIONAL, 6],
  [SeverityLevel.DEBUG, 7],
  [SeverityLevel.TRACE, 8]
]);

/** @internal */
export const MongoLoggableComponent = Object.freeze({
  COMMAND: 'command',
  TOPOLOGY: 'topology',
  SERVER_SELECTION: 'serverSelection',
  CONNECTION: 'connection',
  CLIENT: 'client'
} as const);

/** @internal */
export type MongoLoggableComponent =
  (typeof MongoLoggableComponent)[keyof typeof MongoLoggableComponent];

/** @internal */
export interface MongoLoggerEnvOptions {
  /** Severity level for command component */
  MONGODB_LOG_COMMAND?: string;
  /** Severity level for topology component */
  MONGODB_LOG_TOPOLOGY?: string;
  /** Severity level for server selection component */
  MONGODB_LOG_SERVER_SELECTION?: string;
  /** Severity level for CMAP */
  MONGODB_LOG_CONNECTION?: string;
  /** Severity level for client */
  MONGODB_LOG_CLIENT?: string;
  /** Default severity level to be if any of the above are unset */
  MONGODB_LOG_ALL?: string;
  /** Max length of embedded EJSON docs. Setting to 0 disables truncation. Defaults to 1000. */
  MONGODB_LOG_MAX_DOCUMENT_LENGTH?: string;
  /** Destination for log messages. Must be 'stderr', 'stdout'. Defaults to 'stderr'. */
  MONGODB_LOG_PATH?: string;
}

/** @internal */
export interface LogComponentSeveritiesClientOptions {
  /** Optional severity level for command component */
  command?: SeverityLevel;
  /** Optional severity level for topology component */
  topology?: SeverityLevel;
  /** Optionsl severity level for server selection component */
  serverSelection?: SeverityLevel;
  /** Optional severity level for connection component */
  connection?: SeverityLevel;
  /** Optional severity level for client component */
  client?: SeverityLevel;
  /** Optional default severity level to be used if any of the above are unset */
  default?: SeverityLevel;
}

/** @internal */
export interface MongoLoggerMongoClientOptions {
  /** Destination for log messages */
  mongodbLogPath?: 'stdout' | 'stderr' | MongoDBLogWritable;
  /** Severity levels for logger components */
  mongodbLogComponentSeverities?: LogComponentSeveritiesClientOptions;
  /** Max length of embedded EJSON docs. Setting to 0 disables truncation. Defaults to 1000. */
  mongodbLogMaxDocumentLength?: number;
}

/** @internal */
export interface MongoLoggerOptions {
  componentSeverities: {
    /** Severity level for command component */
    command: SeverityLevel;
    /** Severity level for topology component */
    topology: SeverityLevel;
    /** Severity level for server selection component */
    serverSelection: SeverityLevel;
    /** Severity level for connection component */
    connection: SeverityLevel;
    /** Severity level for client component */
    client: SeverityLevel;
    /** Default severity level to be used if any of the above are unset */
    default: SeverityLevel;
  };
  /** Max length of embedded EJSON docs. Setting to 0 disables truncation. Defaults to 1000. */
  maxDocumentLength: number;
  /** Destination for log messages. */
  logDestination: Writable | MongoDBLogWritable;
}

/**
 * Parses a string as one of SeverityLevel
 *
 * @param s - the value to be parsed
 * @returns one of SeverityLevel if value can be parsed as such, otherwise null
 */
function parseSeverityFromString(s?: string): SeverityLevel | null {
  const validSeverities: string[] = Object.values(SeverityLevel);
  const lowerSeverity = s?.toLowerCase();

  if (lowerSeverity != null && validSeverities.includes(lowerSeverity)) {
    return lowerSeverity as SeverityLevel;
  }

  return null;
}

/** @internal */
export function createStdioLogger(stream: {
  write: NodeJS.WriteStream['write'];
}): MongoDBLogWritable {
  return {
    write: (log: Log): unknown => {
      stream.write(inspect(log, { compact: true, breakLength: Infinity }), 'utf-8');
      return;
    }
  };
}

/**
 * resolves the MONGODB_LOG_PATH and mongodbLogPath options from the environment and the
 * mongo client options respectively. The mongodbLogPath can be either 'stdout', 'stderr', a NodeJS
 * Writable or an object which has a `write` method with the signature:
 * ```ts
 * write(log: Log): void
 * ```
 *
 * @returns the MongoDBLogWritable object to write logs to
 */
function resolveLogPath(
  { MONGODB_LOG_PATH }: MongoLoggerEnvOptions,
  { mongodbLogPath }: MongoLoggerMongoClientOptions
): MongoDBLogWritable {
  if (typeof mongodbLogPath === 'string' && /^stderr$/i.test(mongodbLogPath)) {
    return createStdioLogger(process.stderr);
  }
  if (typeof mongodbLogPath === 'string' && /^stdout$/i.test(mongodbLogPath)) {
    return createStdioLogger(process.stdout);
  }

  if (typeof mongodbLogPath === 'object' && typeof mongodbLogPath?.write === 'function') {
    return mongodbLogPath;
  }

  if (MONGODB_LOG_PATH && /^stderr$/i.test(MONGODB_LOG_PATH)) {
    return createStdioLogger(process.stderr);
  }
  if (MONGODB_LOG_PATH && /^stdout$/i.test(MONGODB_LOG_PATH)) {
    return createStdioLogger(process.stdout);
  }

  return createStdioLogger(process.stderr);
}

function resolveSeverityConfiguration(
  clientOption: string | undefined,
  environmentOption: string | undefined,
  defaultSeverity: SeverityLevel
): SeverityLevel {
  return (
    parseSeverityFromString(clientOption) ??
    parseSeverityFromString(environmentOption) ??
    defaultSeverity
  );
}

/** @internal */
export interface Log extends Record<string, any> {
  t: Date;
  c: MongoLoggableComponent;
  s: SeverityLevel;
  message?: string;
}

/** @internal */
export interface MongoDBLogWritable {
  write(log: Log): void;
}

function compareSeverity(s0: SeverityLevel, s1: SeverityLevel): 1 | 0 | -1 {
  const s0Num = SEVERITY_LEVEL_MAP.getNumericSeverityLevel(s0);
  const s1Num = SEVERITY_LEVEL_MAP.getNumericSeverityLevel(s1);

  return s0Num < s1Num ? -1 : s0Num > s1Num ? 1 : 0;
}

/**
 * @internal
 * Must be separate from Events API due to differences in spec requirements for logging server heartbeat beginning
 */
export type LoggableServerHeartbeatStartedEvent = {
  topologyId: number;
  awaited: boolean;
  connectionId: string;
  name: typeof SERVER_HEARTBEAT_STARTED;
};

/**
 * @internal
 * Must be separate from Events API due to differences in spec requirements for logging server heartbeat success
 */
export type LoggableServerHeartbeatSucceededEvent = {
  topologyId: number;
  awaited: boolean;
  connectionId: string;
  reply: Document;
  serverConnectionId: number | '<monitor>';
  duration: number;
  name: typeof SERVER_HEARTBEAT_SUCCEEDED;
};

/**
 * @internal
 * Must be separate from Events API due to differences in spec requirements for logging server heartbeat failure
 */
export type LoggableServerHeartbeatFailedEvent = {
  topologyId: number;
  awaited: boolean;
  connectionId: string;
  failure: Error;
  duration: number;
  name: typeof SERVER_HEARTBEAT_FAILED;
};

type SDAMLoggableEvent =
  | ServerClosedEvent
  | LoggableServerHeartbeatFailedEvent
  | LoggableServerHeartbeatStartedEvent
  | LoggableServerHeartbeatSucceededEvent
  | ServerOpeningEvent
  | TopologyClosedEvent
  | TopologyDescriptionChangedEvent
  | TopologyOpeningEvent;

/** @internal */
export type LoggableEvent =
  | CommandStartedEvent
  | CommandSucceededEvent
  | CommandFailedEvent
  | ConnectionPoolCreatedEvent
  | ConnectionPoolReadyEvent
  | ConnectionPoolClosedEvent
  | ConnectionPoolClearedEvent
  | ConnectionCreatedEvent
  | ConnectionReadyEvent
  | ConnectionClosedEvent
  | ConnectionCheckedInEvent
  | ConnectionCheckedOutEvent
  | ConnectionCheckOutStartedEvent
  | ConnectionCheckOutFailedEvent
  | ServerClosedEvent
  | LoggableServerHeartbeatFailedEvent
  | LoggableServerHeartbeatStartedEvent
  | LoggableServerHeartbeatSucceededEvent
  | ServerOpeningEvent
  | TopologyClosedEvent
  | TopologyDescriptionChangedEvent
  | TopologyOpeningEvent;

/** @internal */
export interface LogConvertible extends Record<string, any> {
  toLog(): Record<string, any>;
}

/** @internal */
export function stringifyWithMaxLen(
  value: any,
  maxDocumentLength: number,
  options: EJSONOptions = {}
): string {
  const ejson = EJSON.stringify(value, options);

  return maxDocumentLength !== 0 && ejson.length > maxDocumentLength
    ? `${ejson.slice(0, maxDocumentLength)}...`
    : ejson;
}

/** @internal */
export type Loggable = LoggableEvent | LogConvertible;

function isLogConvertible(obj: Loggable): obj is LogConvertible {
  const objAsLogConvertible = obj as LogConvertible;
  // eslint-disable-next-line no-restricted-syntax
  return objAsLogConvertible.toLog !== undefined && typeof objAsLogConvertible.toLog === 'function';
}

function attachCommandFields(
  log: Record<string, any>,
  commandEvent: CommandStartedEvent | CommandSucceededEvent | CommandFailedEvent
) {
  log.commandName = commandEvent.commandName;
  log.requestId = commandEvent.requestId;
  log.driverConnectionId = commandEvent?.connectionId;
  const { host, port } = HostAddress.fromString(commandEvent.address).toHostPort();
  log.serverHost = host;
  log.serverPort = port;
  if (commandEvent?.serviceId) {
    log.serviceId = commandEvent.serviceId.toHexString();
  }

  return log;
}

function attachConnectionFields(
  log: Record<string, any>,
  event: ConnectionPoolMonitoringEvent | ServerOpeningEvent | ServerClosedEvent
) {
  const { host, port } = HostAddress.fromString(event.address).toHostPort();
  log.serverHost = host;
  log.serverPort = port;

  return log;
}

function attachSDAMFields(log: Record<string, any>, sdamEvent: SDAMLoggableEvent) {
  log.topologyId = sdamEvent.topologyId;
  return log;
}

function attachServerHeartbeatFields(
  log: Record<string, any>,
  serverHeartbeatEvent:
    | LoggableServerHeartbeatFailedEvent
    | LoggableServerHeartbeatStartedEvent
    | LoggableServerHeartbeatSucceededEvent
) {
  const { awaited, connectionId } = serverHeartbeatEvent;
  log.awaited = awaited;
  log.driverConnectionId = serverHeartbeatEvent.connectionId;
  const { host, port } = HostAddress.fromString(connectionId).toHostPort();
  log.serverHost = host;
  log.serverPort = port;
  return log;
}

function defaultLogTransform(
  logObject: LoggableEvent | Record<string, any>,
  maxDocumentLength: number = DEFAULT_MAX_DOCUMENT_LENGTH
): Omit<Log, 's' | 't' | 'c'> {
  let log: Omit<Log, 's' | 't' | 'c'> = Object.create(null);

  switch (logObject.name) {
    case COMMAND_STARTED:
      log = attachCommandFields(log, logObject);
      log.message = 'Command started';
      log.command = stringifyWithMaxLen(logObject.command, maxDocumentLength);
      log.databaseName = logObject.databaseName;
      return log;
    case COMMAND_SUCCEEDED:
      log = attachCommandFields(log, logObject);
      log.message = 'Command succeeded';
      log.durationMS = logObject.duration;
      log.reply = stringifyWithMaxLen(logObject.reply, maxDocumentLength);
      return log;
    case COMMAND_FAILED:
      log = attachCommandFields(log, logObject);
      log.message = 'Command failed';
      log.durationMS = logObject.duration;
      log.failure = logObject.failure;
      return log;
    case CONNECTION_POOL_CREATED:
      log = attachConnectionFields(log, logObject);
      log.message = 'Connection pool created';
      if (logObject.options) {
        const { maxIdleTimeMS, minPoolSize, maxPoolSize, maxConnecting, waitQueueTimeoutMS } =
          logObject.options;
        log = {
          ...log,
          maxIdleTimeMS,
          minPoolSize,
          maxPoolSize,
          maxConnecting,
          waitQueueTimeoutMS
        };
      }
      return log;
    case CONNECTION_POOL_READY:
      log = attachConnectionFields(log, logObject);
      log.message = 'Connection pool ready';
      return log;
    case CONNECTION_POOL_CLEARED:
      log = attachConnectionFields(log, logObject);
      log.message = 'Connection pool cleared';
      if (logObject.serviceId?._bsontype === 'ObjectId') {
        log.serviceId = logObject.serviceId.toHexString();
      }
      return log;
    case CONNECTION_POOL_CLOSED:
      log = attachConnectionFields(log, logObject);
      log.message = 'Connection pool closed';
      return log;
    case CONNECTION_CREATED:
      log = attachConnectionFields(log, logObject);
      log.message = 'Connection created';
      log.driverConnectionId = logObject.connectionId;
      return log;
    case CONNECTION_READY:
      log = attachConnectionFields(log, logObject);
      log.message = 'Connection ready';
      log.driverConnectionId = logObject.connectionId;
      return log;
    case CONNECTION_CLOSED:
      log = attachConnectionFields(log, logObject);
      log.message = 'Connection closed';
      log.driverConnectionId = logObject.connectionId;
      switch (logObject.reason) {
        case 'stale':
          log.reason = 'Connection became stale because the pool was cleared';
          break;
        case 'idle':
          log.reason =
            'Connection has been available but unused for longer than the configured max idle time';
          break;
        case 'error':
          log.reason = 'An error occurred while using the connection';
          if (logObject.error) {
            log.error = logObject.error;
          }
          break;
        case 'poolClosed':
          log.reason = 'Connection pool was closed';
          break;
        default:
          log.reason = `Unknown close reason: ${logObject.reason}`;
      }
      return log;
    case CONNECTION_CHECK_OUT_STARTED:
      log = attachConnectionFields(log, logObject);
      log.message = 'Connection checkout started';
      return log;
    case CONNECTION_CHECK_OUT_FAILED:
      log = attachConnectionFields(log, logObject);
      log.message = 'Connection checkout failed';
      switch (logObject.reason) {
        case 'poolClosed':
          log.reason = 'Connection pool was closed';
          break;
        case 'timeout':
          log.reason = 'Wait queue timeout elapsed without a connection becoming available';
          break;
        case 'connectionError':
          log.reason = 'An error occurred while trying to establish a new connection';
          if (logObject.error) {
            log.error = logObject.error;
          }
          break;
        default:
          log.reason = `Unknown close reason: ${logObject.reason}`;
      }
      return log;
    case CONNECTION_CHECKED_OUT:
      log = attachConnectionFields(log, logObject);
      log.message = 'Connection checked out';
      log.driverConnectionId = logObject.connectionId;
      return log;
    case CONNECTION_CHECKED_IN:
      log = attachConnectionFields(log, logObject);
      log.message = 'Connection checked in';
      log.driverConnectionId = logObject.connectionId;
      return log;
    case SERVER_OPENING:
      log = attachSDAMFields(log, logObject);
      log = attachConnectionFields(log, logObject);
      log.message = 'Starting server monitoring';
      return log;
    case SERVER_CLOSED:
      log = attachSDAMFields(log, logObject);
      log = attachConnectionFields(log, logObject);
      log.message = 'Stopped server monitoring';
      return log;
    case SERVER_HEARTBEAT_STARTED:
      log = attachSDAMFields(log, logObject);
      log = attachServerHeartbeatFields(log, logObject);
      log.message = 'Server heartbeat started';
      return log;
    case SERVER_HEARTBEAT_SUCCEEDED:
      log = attachSDAMFields(log, logObject);
      log = attachServerHeartbeatFields(log, logObject);
      log.message = 'Server heartbeat succeeded';
      log.durationMS = logObject.duration;
      log.serverConnectionId = logObject.serverConnectionId;
      log.reply = stringifyWithMaxLen(logObject.reply, maxDocumentLength, { relaxed: true });
      return log;
    case SERVER_HEARTBEAT_FAILED:
      log = attachSDAMFields(log, logObject);
      log = attachServerHeartbeatFields(log, logObject);
      log.message = 'Server heartbeat failed';
      log.durationMS = logObject.duration;
      log.failure = logObject.failure.message;
      return log;
    case TOPOLOGY_OPENING:
      log = attachSDAMFields(log, logObject);
      log.message = 'Starting topology monitoring';
      return log;
    case TOPOLOGY_CLOSED:
      log = attachSDAMFields(log, logObject);
      log.message = 'Stopped topology monitoring';
      return log;
    case TOPOLOGY_DESCRIPTION_CHANGED:
      log = attachSDAMFields(log, logObject);
      log.message = 'Topology description changed';
      log.previousDescription = log.reply = stringifyWithMaxLen(
        logObject.previousDescription,
        maxDocumentLength
      );
      log.newDescription = log.reply = stringifyWithMaxLen(
        logObject.newDescription,
        maxDocumentLength
      );
      return log;
    default:
      for (const [key, value] of Object.entries(logObject)) {
        if (value != null) log[key] = value;
      }
  }
  return log;
}

/** @internal */
export class MongoLogger {
  componentSeverities: Record<MongoLoggableComponent, SeverityLevel>;
  maxDocumentLength: number;
  logDestination: MongoDBLogWritable | Writable;

  /**
   * This method should be used when logging errors that do not have a public driver API for
   * reporting errors.
   */
  error = this.log.bind(this, 'error');
  /**
   * This method should be used to log situations where undesirable application behaviour might
   * occur. For example, failing to end sessions on `MongoClient.close`.
   */
  warn = this.log.bind(this, 'warn');
  /**
   * This method should be used to report high-level information about normal driver behaviour.
   * For example, the creation of a `MongoClient`.
   */
  info = this.log.bind(this, 'info');
  /**
   * This method should be used to report information that would be helpful when debugging an
   * application. For example, a command starting, succeeding or failing.
   */
  debug = this.log.bind(this, 'debug');
  /**
   * This method should be used to report fine-grained details related to logic flow. For example,
   * entering and exiting a function body.
   */
  trace = this.log.bind(this, 'trace');

  constructor(options: MongoLoggerOptions) {
    this.componentSeverities = options.componentSeverities;
    this.maxDocumentLength = options.maxDocumentLength;
    this.logDestination = options.logDestination;
  }

  private log(
    severity: SeverityLevel,
    component: MongoLoggableComponent,
    message: Loggable | string
  ): void {
    if (compareSeverity(severity, this.componentSeverities[component]) > 0) return;

    let logMessage: Log = { t: new Date(), c: component, s: severity };
    if (typeof message === 'string') {
      logMessage.message = message;
    } else if (typeof message === 'object') {
      if (isLogConvertible(message)) {
        logMessage = { ...logMessage, ...message.toLog() };
      } else {
        logMessage = { ...logMessage, ...defaultLogTransform(message, this.maxDocumentLength) };
      }
    }
    this.logDestination.write(logMessage);
  }

  /**
   * Merges options set through environment variables and the MongoClient, preferring environment
   * variables when both are set, and substituting defaults for values not set. Options set in
   * constructor take precedence over both environment variables and MongoClient options.
   *
   * @remarks
   * When parsing component severity levels, invalid values are treated as unset and replaced with
   * the default severity.
   *
   * @param envOptions - options set for the logger from the environment
   * @param clientOptions - options set for the logger in the MongoClient options
   * @returns a MongoLoggerOptions object to be used when instantiating a new MongoLogger
   */
  static resolveOptions(
    envOptions: MongoLoggerEnvOptions,
    clientOptions: MongoLoggerMongoClientOptions
  ): MongoLoggerOptions {
    // client options take precedence over env options
    const combinedOptions = {
      ...envOptions,
      ...clientOptions,
      mongodbLogPath: resolveLogPath(envOptions, clientOptions)
    };
    const defaultSeverity = resolveSeverityConfiguration(
      combinedOptions.mongodbLogComponentSeverities?.default,
      combinedOptions.MONGODB_LOG_ALL,
      SeverityLevel.OFF
    );

    return {
      componentSeverities: {
        command: resolveSeverityConfiguration(
          combinedOptions.mongodbLogComponentSeverities?.command,
          combinedOptions.MONGODB_LOG_COMMAND,
          defaultSeverity
        ),
        topology: resolveSeverityConfiguration(
          combinedOptions.mongodbLogComponentSeverities?.topology,
          combinedOptions.MONGODB_LOG_TOPOLOGY,
          defaultSeverity
        ),
        serverSelection: resolveSeverityConfiguration(
          combinedOptions.mongodbLogComponentSeverities?.serverSelection,
          combinedOptions.MONGODB_LOG_SERVER_SELECTION,
          defaultSeverity
        ),
        connection: resolveSeverityConfiguration(
          combinedOptions.mongodbLogComponentSeverities?.connection,
          combinedOptions.MONGODB_LOG_CONNECTION,
          defaultSeverity
        ),
        client: resolveSeverityConfiguration(
          combinedOptions.mongodbLogComponentSeverities?.client,
          combinedOptions.MONGODB_LOG_CLIENT,
          defaultSeverity
        ),
        default: defaultSeverity
      },
      maxDocumentLength:
        combinedOptions.mongodbLogMaxDocumentLength ??
        parseUnsignedInteger(combinedOptions.MONGODB_LOG_MAX_DOCUMENT_LENGTH) ??
        1000,
      logDestination: combinedOptions.mongodbLogPath
    };
  }
}
