import React from 'react';
import { BrowserRouter as Router, Navigate, Routes, Route, useParams } from 'react-router-dom';
import { SocketProvider } from './context/SocketContext';
import GameBoard from './components/GameBoard';
import MentorWorkspace from './features/mentor/MentorWorkspace';
import './App.css';

function LegacyMentorConversationRedirect() {
  const { conversationId } = useParams();
  return <Navigate to={`/mentor/${conversationId}`} replace />;
}

function App() {
  return (
    <SocketProvider>
      <Router>
        <Routes>
          <Route path="/" element={<GameBoard />} />
          <Route path="/mentor" element={<MentorWorkspace />} />
          <Route path="/mentor/:conversationId" element={<MentorWorkspace />} />
          <Route path="/mentor-live" element={<Navigate to="/mentor" replace />} />
          <Route path="/mentor-v2" element={<Navigate to="/mentor" replace />} />
          <Route path="/mentor-v2/:conversationId" element={<LegacyMentorConversationRedirect />} />
        </Routes>
      </Router>
    </SocketProvider>
  );
}

export default App;
