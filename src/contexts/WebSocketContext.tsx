import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { useAuth } from '../components/auth/context/AuthContext';

/**
 * One frame received from the chat websocket. The server guarantees every
 * frame carries a `kind` (provider message kinds plus gateway kinds such as
 * `chat_subscribed`, `session_upserted`, `loading_progress`, and
 * `protocol_error`). The synthetic `websocket_reconnected` kind is injected
 * client-side when the socket re-opens after a drop.
 */
export type ServerEvent = {
  kind?: string;
  type?: string;
  sessionId?: string;
  seq?: number;
  [key: string]: unknown;
};

type ServerEventListener = (event: ServerEvent) => void;

type WebSocketContextType = {
  ws: WebSocket | null;
  sendMessage: (message: unknown) => void;
  subscribe: (listener: ServerEventListener) => () => void;
  latestMessage: ServerEvent | null;
  isConnected: boolean;
};

const WebSocketContext = createContext<WebSocketContextType | null>(null);

export const useWebSocket = () => {
  const context = useContext(WebSocketContext);
  if (!context) throw new Error('useWebSocket must be used within a WebSocketProvider');
  return context;
};

const buildWebSocketUrl = () => {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
};

const useWebSocketProviderState = (): WebSocketContextType => {
  const wsRef = useRef<WebSocket | null>(null);
  const socketGenerationRef = useRef(0);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unmountedRef = useRef(false);
  const hasConnectedRef = useRef(false);
  const listenersRef = useRef(new Set<ServerEventListener>());
  const [socket, setSocket] = useState<WebSocket | null>(null);
  const [latestMessage, setLatestMessage] = useState<ServerEvent | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const { token } = useAuth();

  const dispatch = useCallback((event: ServerEvent) => {
    for (const listener of listenersRef.current) {
      try {
        listener(event);
      } catch (error) {
        console.error('WebSocket listener error:', error);
      }
    }
    setLatestMessage(event);
  }, []);

  const clearReconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
  }, []);

  const connect = useCallback((generation: number, isAuthenticated: boolean) => {
    if (unmountedRef.current || socketGenerationRef.current !== generation || !isAuthenticated) return;
    const wsUrl = buildWebSocketUrl();

    try {
      const websocket = new WebSocket(wsUrl);
      // Claim ownership before any asynchronous browser callback can fire.
      wsRef.current = websocket;
      setSocket(websocket);

      const isCurrentSocket = () =>
        !unmountedRef.current && socketGenerationRef.current === generation && wsRef.current === websocket;

      websocket.onopen = () => {
        if (!isCurrentSocket()) return;
        setIsConnected(true);
        if (hasConnectedRef.current) dispatch({ kind: 'websocket_reconnected', timestamp: Date.now() });
        hasConnectedRef.current = true;
      };

      websocket.onmessage = (event) => {
        if (!isCurrentSocket()) return;
        try {
          dispatch(JSON.parse(event.data) as ServerEvent);
        } catch (error) {
          console.error('Error parsing WebSocket message:', error);
        }
      };

      websocket.onclose = () => {
        if (!isCurrentSocket()) return;
        setIsConnected(false);
        wsRef.current = null;
        setSocket(null);
        clearReconnect();
        reconnectTimeoutRef.current = setTimeout(() => {
          reconnectTimeoutRef.current = null;
          if (unmountedRef.current || socketGenerationRef.current !== generation) return;
          connect(generation, isAuthenticated);
        }, 3000);
      };

      websocket.onerror = (event) => {
        if (isCurrentSocket()) console.error('WebSocket error:', event);
      };
    } catch (error) {
      if (socketGenerationRef.current === generation && !unmountedRef.current) {
        console.error('Error creating WebSocket connection:', error);
      }
    }
  }, [clearReconnect, dispatch]);

  useEffect(() => {
    unmountedRef.current = false;
    const generation = socketGenerationRef.current + 1;
    socketGenerationRef.current = generation;
    clearReconnect();

    const previousSocket = wsRef.current;
    wsRef.current = null;
    setSocket(null);
    setIsConnected(false);
    previousSocket?.close();
    connect(generation, Boolean(token));

    return () => {
      if (socketGenerationRef.current !== generation) return;
      socketGenerationRef.current += 1;
      clearReconnect();
      const activeSocket = wsRef.current;
      wsRef.current = null;
      setSocket(null);
      setIsConnected(false);
      activeSocket?.close();
    };
  }, [clearReconnect, connect, token]);

  useEffect(() => () => {
    unmountedRef.current = true;
  }, []);

  const sendMessage = useCallback((message: unknown) => {
    const activeSocket = wsRef.current;
    if (activeSocket?.readyState === WebSocket.OPEN) activeSocket.send(JSON.stringify(message));
    else console.warn('WebSocket not connected');
  }, []);

  const subscribe = useCallback((listener: ServerEventListener) => {
    listenersRef.current.add(listener);
    return () => listenersRef.current.delete(listener);
  }, []);

  return useMemo(() => ({
    ws: socket,
    sendMessage,
    subscribe,
    latestMessage,
    isConnected,
  }), [isConnected, latestMessage, sendMessage, socket, subscribe]);
};

export const WebSocketProvider = ({ children }: { children: React.ReactNode }) => {
  const webSocketData = useWebSocketProviderState();
  return <WebSocketContext.Provider value={webSocketData}>{children}</WebSocketContext.Provider>;
};

export default WebSocketContext;
