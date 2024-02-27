import * as Ably from 'ably';
import { useEffect, useRef } from 'react';
import { ChannelParameters } from '../AblyReactHooks.js';
import { useAbly } from './useAbly.js';
import { useStateErrors } from './useStateErrors.js';
import { useChannelInstance } from './useChannelInstance.js';

export type AblyMessageCallback = Ably.messageCallback<Ably.Message>;

export interface ChannelResult {
  channel: Ably.RealtimeChannel;
  ably: Ably.RealtimeClient;
  connectionError: Ably.ErrorInfo | null;
  channelError: Ably.ErrorInfo | null;
}

type SubscribeArgs = [string, AblyMessageCallback] | [AblyMessageCallback];

export function useChannel(
  channelNameOrNameAndOptions: ChannelParameters,
  callbackOnMessage?: AblyMessageCallback
): ChannelResult;
export function useChannel(
  channelNameOrNameAndOptions: ChannelParameters,
  event: string,
  callbackOnMessage?: AblyMessageCallback
): ChannelResult;

export function useChannel(
  channelNameOrNameAndOptions: ChannelParameters,
  eventOrCallback?: string | AblyMessageCallback,
  callback?: AblyMessageCallback
): ChannelResult {
  const channelHookOptions =
    typeof channelNameOrNameAndOptions === 'object'
      ? channelNameOrNameAndOptions
      : { channelName: channelNameOrNameAndOptions };

  const ably = useAbly(channelHookOptions.id);
  const { channelName, skip } = channelHookOptions;

  const channel = useChannelInstance(channelHookOptions.id, channelName);

  const channelEvent = typeof eventOrCallback === 'string' ? eventOrCallback : null;
  const ablyMessageCallback = typeof eventOrCallback === 'string' ? callback : eventOrCallback;

  const ablyMessageCallbackRef = useRef(ablyMessageCallback);

  const { connectionError, channelError } = useStateErrors(channelHookOptions);

  useEffect(() => {
    ablyMessageCallbackRef.current = ablyMessageCallback;
  }, [ablyMessageCallback]);

  useEffect(() => {
    const listener: AblyMessageCallback | null = ablyMessageCallbackRef.current
      ? (message) => {
          ablyMessageCallbackRef.current && ablyMessageCallbackRef.current(message);
        }
      : null;

    const subscribeArgs: SubscribeArgs | null = listener
      ? channelEvent === null
        ? [listener]
        : [channelEvent, listener]
      : null;

    if (!skip && subscribeArgs) {
      handleChannelMount(channel, ...subscribeArgs);
    }

    return () => {
      !skip && subscribeArgs && handleChannelUnmount(channel, ...subscribeArgs);
    };
  }, [channelEvent, channel, skip]);

  return { channel, ably, connectionError, channelError };
}

async function handleChannelMount(channel: Ably.RealtimeChannel, ...subscribeArgs: SubscribeArgs) {
  await (channel.subscribe as any)(...subscribeArgs);
}

async function handleChannelUnmount(channel: Ably.RealtimeChannel, ...subscribeArgs: SubscribeArgs) {
  await (channel.unsubscribe as any)(...subscribeArgs);

  setTimeout(async () => {
    // React is very mount/unmount happy, so if we just detatch the channel
    // it's quite likely it will be reattached again by a subsequent handleChannelMount calls.
    // To solve this, we set a timer, and if all the listeners have been removed, we know that the component
    // has been removed for good and we can detatch the channel.
    if (channel.listeners.length === 0) {
      await channel.detach();
    }
  }, 2500);
}
