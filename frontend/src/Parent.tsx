import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { motion, useReducedMotion } from 'framer-motion';
import Brand from './Brand';
import { LanguageSwitcher, useLanguage } from './i18n';
import { formatPassKey, parentLogin, parentLogout, parentSession, ParentError } from './parent-api';
import './admin.css';
import './portal.css';

/** The parents' page: sign in with nothing but the pass key from the school. */
export default function Parent() {
  const { locale, t } = useLanguage();
  const reduced = useReducedMotion();
  const client = useQueryClient();
  const [passKey, setPassKey] = useState('');
  const [incomplete, setIncomplete] = useState(false);
  const session = useQuery({ queryKey: ['parent', 'session'], queryFn: parentSession, retry: false, staleTime: 0 });
  const login = useMutation({ mutationFn: () => parentLogin(passKey), onSuccess: child => { window.scrollTo(0, 0); setPassKey(''); client.setQueryData(['parent', 'session'], child); }, retry: false });
  const logout = useMutation({ mutationFn: parentLogout, onSuccess: () => client.setQueryData(['parent', 'session'], null), retry: false });
  useEffect(() => { document.title = `${t('For parents')} — ${t('Boborahim Mashrab')}`; }, [locale]);

  function submit(event: FormEvent) {
    event.preventDefault();
    // A complete key is twelve characters plus two dashes; anything shorter is not sent.
    if (passKey.length < 14) { setIncomplete(true); return; }
    login.mutate();
  }
  function errorMessage(error: Error | null) { return t(error instanceof ParentError ? error.message : 'Parent sign-in is unavailable right now. Please try again later.'); }
  const child = session.data;
  const problem = incomplete ? t('The pass key has 12 letters and digits. Please enter all of it.') : login.isError ? errorMessage(login.error) : null;

  return <div className="admin-page parent-page">
    <a className="skip" href="#parent-main">{t('Skip to content')}</a>
    <header className="admin-header"><Brand /><div className="admin-header-actions"><LanguageSwitcher /></div></header>
    <main id="parent-main" className="admin-main">
      {!child ? <motion.section className="admin-login portal-login" initial={reduced ? false : { opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
        <span className="admin-lock" aria-hidden="true"><KeyIcon size={27} /></span>
        <p className="admin-eyebrow">{t('For parents')}</p><h1>{t('Parent sign-in')}</h1><p>{t('Enter the pass key the school gave you. That is all you need.')}</p>
        {session.isPending ? <p role="status">{t('Loading…')}</p> : session.isError ? <div role="alert" className="admin-error"><p>{errorMessage(session.error)}</p><button className="admin-secondary" onClick={() => session.refetch()}>{t('Try again')}</button></div> : <form onSubmit={submit} noValidate>
          <label htmlFor="parent-pass-key">{t('Pass key')}<input id="parent-pass-key" className="portal-key-input" value={passKey} placeholder="XXXX-XXXX-XXXX" maxLength={20} inputMode="text" autoComplete="off" autoCapitalize="characters" autoCorrect="off" spellCheck={false} autoFocus onChange={event => { setPassKey(formatPassKey(event.target.value)); setIncomplete(false); login.reset(); }} aria-invalid={!!problem} aria-describedby={problem ? 'parent-key-error' : 'parent-key-hint'} required /></label>
          {problem ? <p id="parent-key-error" role="alert" className="admin-error">{problem}</p> : <p id="parent-key-hint" className="portal-hint">{t('Capital or small letters both work, and the dashes are added for you.')}</p>}
          <button className="button admin-login-button" type="submit" disabled={login.isPending}>{t(login.isPending ? 'Signing in…' : 'Sign in')}<span>↗</span></button>
        </form>}
        <p className="admin-access-hint">{t('No pass key, or it does not work? Please ask the school office for a new one.')}</p><a className="text-link" href="/">← {t('Back to website')}</a>
      </motion.section> : <motion.section className="admin-login portal-login" initial={reduced ? false : { opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
        {/* Nothing is built for signed-in parents yet; this only confirms the sign-in worked. */}
        <span className="admin-lock portal-signed-in" aria-hidden="true"><svg viewBox="0 0 24 24" width="27" height="27" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12.500 4.500 4.500L19 7.500" /></svg></span>
        <p className="admin-eyebrow">{t('For parents')}</p><h1>{t('You are signed in')}</h1><p>{t('Your pass key was accepted. The parent pages are being prepared and will appear here.')}</p>
        {logout.isError && <p className="admin-error" role="alert">{errorMessage(logout.error)}</p>}
        <button className="button admin-login-button portal-sign-out" type="button" onClick={() => logout.mutate()} disabled={logout.isPending}>{t('Sign out')}<span>↗</span></button>
        <a className="text-link" href="/">← {t('Back to website')}</a>
      </motion.section>}
    </main>
  </div>;
}

function KeyIcon({ size }: { size: number }) {
  return <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round"><circle cx="8" cy="15" r="4" /><path d="m11 12 8.500-8.500M16 6.500l2.500 2.500M13.500 9l2 2" /></svg>;
}
