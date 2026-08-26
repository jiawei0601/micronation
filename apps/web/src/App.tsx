import { BrowserRouter, Route, Routes } from 'react-router-dom';
import MapShell from './pages/MapShell';
import TreatyPage from './pages/TreatyPage';
import LoginPage from './pages/auth/LoginPage';
import RegisterPage from './pages/auth/RegisterPage';
import FoundingPage from './pages/auth/FoundingPage';
import PanelLayout from './pages/panels/PanelLayout';
import NationPage from './pages/panels/NationPage';
import BuildPage from './pages/panels/BuildPage';
import PolicyPage from './pages/panels/PolicyPage';
import MarketPage from './pages/panels/MarketPage';
import MilitaryPage from './pages/panels/MilitaryPage';
import DiplomacyPage from './pages/panels/DiplomacyPage';
import RankingsPage from './pages/panels/RankingsPage';
import TasksPage from './pages/panels/TasksPage';

/** 路由表對齊 docs/CONTRACT.md §web:/ 為 C 地圖主殼;功能頁走 B 深色面板;/treaty/:id 為 A 公文風。 */
export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<MapShell />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/founding" element={<FoundingPage />} />
        <Route path="/treaty/:id" element={<TreatyPage />} />
        <Route element={<PanelLayout />}>
          <Route path="/nation" element={<NationPage />} />
          <Route path="/build" element={<BuildPage />} />
          <Route path="/policy" element={<PolicyPage />} />
          <Route path="/market" element={<MarketPage />} />
          <Route path="/military" element={<MilitaryPage />} />
          <Route path="/diplomacy" element={<DiplomacyPage />} />
          <Route path="/rankings" element={<RankingsPage />} />
          <Route path="/tasks" element={<TasksPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

export default App;
