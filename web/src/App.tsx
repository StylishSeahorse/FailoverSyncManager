import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth';
import { ApplicationDetail, ApplicationsPage } from './pages/Applications';
import { Dashboard } from './pages/Dashboard';
import { Events } from './pages/Events';
import { Login } from './pages/Login';
import { OperationDetail, OperationsList } from './pages/Operations';
import { HealthChecksPage, IntegrationsPage, PolicyPage, SitesPage, UsersPage } from './pages/Settings';

export function App() {
  const { me, loading, logout, can } = useAuth();
  if (loading) return <p className="muted" style={{ padding: 24 }}>Loading…</p>;
  if (!me) return <Login />;
  return (
    <div className="shell">
      <nav className="nav" aria-label="Main">
        <div className="brand">Failover Controller</div>
        <NavLink to="/" end>
          Dashboard
        </NavLink>
        <NavLink to="/operations">Operations</NavLink>
        <NavLink to="/events">Event log</NavLink>
        <NavLink to="/sites">Sites</NavLink>
        <NavLink to="/applications">Applications</NavLink>
        <NavLink to="/integrations">Integrations</NavLink>
        <NavLink to="/health-checks">Health checks</NavLink>
        <NavLink to="/policy">Policy</NavLink>
        {can('admin') && <NavLink to="/users">Users</NavLink>}
        <div className="spacer" />
        <div className="who">
          {me.username} · {me.role}
        </div>
        <button className="ghost small" onClick={() => void logout()}>
          Sign out
        </button>
      </nav>
      <main className="main">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/operations" element={<OperationsList />} />
          <Route path="/operations/:id" element={<OperationDetail />} />
          <Route path="/events" element={<Events />} />
          <Route path="/sites" element={<SitesPage />} />
          <Route path="/applications" element={<ApplicationsPage />} />
          <Route path="/applications/:id" element={<ApplicationDetail />} />
          <Route path="/integrations" element={<IntegrationsPage />} />
          <Route path="/health-checks" element={<HealthChecksPage />} />
          <Route path="/policy" element={<PolicyPage />} />
          {can('admin') && <Route path="/users" element={<UsersPage />} />}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
