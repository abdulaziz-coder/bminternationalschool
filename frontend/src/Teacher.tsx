import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { motion, useReducedMotion } from 'framer-motion';
import Brand from './Brand';
import { LanguageSwitcher, useLanguage } from './i18n';
import { teacherLogin, teacherLogout, teacherSession, TeacherError } from './teacher-api';
import TeacherHome from './TeacherHome';
import './admin.css';
import './portal.css';

/** The teachers' page: sign in with the login and password an admin generated (there is no sign-up), then the teacher's week. */
export default function Teacher() {
  const { locale, t } = useLanguage();
  const reduced = useReducedMotion();
  const client = useQueryClient();
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [shown, setShown] = useState(false);
  const [incomplete, setIncomplete] = useState(false);
  const session = useQuery({ queryKey: ['teacher', 'session'], queryFn: teacherSession, retry: false, staleTime: 0 });
  const signIn = useMutation({ mutationFn: () => teacherLogin(login.trim(), password), onSuccess: teacher => { window.scrollTo(0, 0); setPassword(''); setShown(false); client.setQueryData(['teacher', 'session'], teacher); }, retry: false });
  const signOut = useMutation({ mutationFn: teacherLogout, onSuccess: () => { client.removeQueries({ queryKey: ['teacher'] }); client.setQueryData(['teacher', 'session'], null); }, retry: false });
  useEffect(() => { document.title = `${t('For teachers')} — ${t('Boborahim Mashrab')}`; }, [locale]);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!login.trim() || !password) { setIncomplete(true); return; }
    signIn.mutate();
  }
  function edited() { setIncomplete(false); signIn.reset(); }
  function errorMessage(error: Error | null) { return t(error instanceof TeacherError ? error.message : 'Teacher sign-in is unavailable right now. Please try again later.'); }
  const teacher = session.data;
  const problem = incomplete ? t('Please enter your login and password.') : signIn.isError ? errorMessage(signIn.error) : null;

  return <div className="admin-page">
    <a className="skip" href="#teacher-main">{t('Skip to content')}</a>
    <header className="admin-header"><Brand /><div className="admin-header-actions"><LanguageSwitcher />{teacher && <button className="admin-secondary" onClick={() => signOut.mutate()} disabled={signOut.isPending}>{t('Sign out')}</button>}</div></header>
    <main id="teacher-main" className={teacher ? 'admin-main admin-main-wide' : 'admin-main'}>
      {!teacher ? <motion.section className="admin-login portal-login" initial={reduced ? false : { opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
        <span className="admin-lock" aria-hidden="true"><svg viewBox="0 0 24 24" width="27" height="27" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round"><path d="M3 5.500h18v10H3zM8 19.500l4-4 4 4M7 9.500h6M7 12h4" /></svg></span>
        <p className="admin-eyebrow">{t('For teachers')}</p><h1>{t('Teacher sign-in')}</h1><p>{t('Sign in with the login and password the school gave you.')}</p>
        {session.isPending ? <p role="status">{t('Loading…')}</p> : session.isError ? <div role="alert" className="admin-error"><p>{errorMessage(session.error)}</p><button className="admin-secondary" onClick={() => session.refetch()}>{t('Try again')}</button></div> : <form onSubmit={submit} noValidate>
          <label htmlFor="teacher-login">{t('Login')}<input id="teacher-login" value={login} placeholder="familiya.ism" maxLength={60} autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} autoFocus onChange={event => { setLogin(event.target.value); edited(); }} aria-invalid={!!problem} aria-describedby={problem ? 'teacher-error' : undefined} required /></label>
          <label htmlFor="teacher-password" className="portal-password">{t('Password')}<input id="teacher-password" type={shown ? 'text' : 'password'} value={password} maxLength={128} autoComplete="current-password" autoCapitalize="none" autoCorrect="off" spellCheck={false} onChange={event => { setPassword(event.target.value); edited(); }} aria-invalid={!!problem} aria-describedby={problem ? 'teacher-error' : 'teacher-hint'} required /><button type="button" aria-pressed={shown} onClick={() => setShown(!shown)}>{t(shown ? 'Hide password' : 'Show password')}</button></label>
          {problem ? <p id="teacher-error" role="alert" className="admin-error">{problem}</p> : <p id="teacher-hint" className="portal-hint">{t('Capital and small letters in the password are different.')}</p>}
          <button className="button admin-login-button" type="submit" disabled={signIn.isPending}>{t(signIn.isPending ? 'Signing in…' : 'Sign in')}<span>↗</span></button>
        </form>}
        <p className="admin-access-hint">{t('Forgotten your password? Ask the school office to generate a new one.')}</p><a className="text-link" href="/">← {t('Back to website')}</a>
      </motion.section> : <>
        {signOut.isError && <p className="admin-error" role="alert">{errorMessage(signOut.error)}</p>}
        <TeacherHome teacher={teacher} onSignedOut={() => client.setQueryData(['teacher', 'session'], null)} />
      </>}
    </main>
  </div>;
}
