import { useContext } from 'react';
import { SocketContext } from './socket-context';

export const useSocket = () => useContext(SocketContext);
