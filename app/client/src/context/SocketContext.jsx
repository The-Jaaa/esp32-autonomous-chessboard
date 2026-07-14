import React, { useEffect, useState } from 'react';
import { io } from 'socket.io-client';
import { SocketContext } from './socket-context';

export const SocketProvider = ({ children }) => {
  const [socket, setSocket] = useState(null);

  useEffect(() => {
    // In Vite dev, the server config proxies /socket.io requests to port 3000 automatically.
    // So we don't need to specify the port explicitly, which makes it work out-of-the-box in prod.
    const newSocket = io();
    setSocket(newSocket);

    return () => {
      newSocket.close();
    };
  }, []);

  return (
    <SocketContext.Provider value={socket}>
      {children}
    </SocketContext.Provider>
  );
};
