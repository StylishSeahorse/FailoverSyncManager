import { useState } from 'react';
import { useAuth } from '../auth';
import { ErrorBox, useAction } from '../components/ui';

export function Login() {
  const { login } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const act = useAction(login);
  return (
    <div className="login">
      <form
        className="panel stack"
        onSubmit={(e) => {
          e.preventDefault();
          void act.run(username, password);
        }}
      >
        <div>
          <h1>Failover Controller</h1>
          <p className="muted">Sign in to continue.</p>
        </div>
        <label>
          Username
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus required />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </label>
        <ErrorBox error={act.error} />
        <button className="primary" type="submit" disabled={act.busy}>
          {act.busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
