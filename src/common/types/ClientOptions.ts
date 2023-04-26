import { Modify } from './utils';
import * as API from '../../../ably';

export type RestAgentOptions = {
  keepAlive: boolean;
  maxSockets: number;
};

export default interface ClientOptions extends API.Types.ClientOptions {
  restAgentOptions?: RestAgentOptions;
  pushFullWait?: boolean;
  agents?: string[];
}

export type DeprecatedClientOptions = Modify<
  ClientOptions,
  {
    queueEvents?: boolean;
    promises?: boolean;
    headers?: Record<string, string>;
    maxMessageSize?: number;
  }
>;

export type NormalisedClientOptions = Modify<
  DeprecatedClientOptions,
  {
    realtimeHost: string;
    restHost: string;
    keyName?: string;
    keySecret?: string;
    timeouts: Record<string, number>;
    maxMessageSize: number;
    connectivityCheckParams: Record<string, string> | null;
  }
>;
