import { Routes, Route } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import Historical from './routes/Historical';
import Live from './routes/Live';

export default function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/" element={<Historical />} />
        <Route path="/live" element={<Live />} />
      </Route>
    </Routes>
  );
}
