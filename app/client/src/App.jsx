import React from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { SocketProvider } from './context/SocketContext';
import GameBoard from './components/GameBoard';
import LiveMentor from './components/LiveMentor';
import MentorWorkspace from './features/mentor/MentorWorkspace';
import './App.css';

function App() {
  return (
    <SocketProvider>
      <Router>
        <Routes>
          <Route path="/" element={<GameBoard />} />
          <Route path="/mentor" element={<LiveMentor />} />
          <Route path="/mentor-v2" element={<MentorWorkspace />} />
          <Route path="/mentor-v2/:conversationId" element={<MentorWorkspace />} />
        </Routes>
      </Router>
    </SocketProvider>
  );
}

export default App;
