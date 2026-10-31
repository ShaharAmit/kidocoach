import type { SignInProvider } from '../services/accountAuth';

interface Props {
  provider: SignInProvider;
  disabled: boolean;
  onClick: () => void;
}

export default function ProviderSignInButton({ provider, disabled, onClick }: Props) {
  return (
    <button type="button" className={`provider-sign-in provider-sign-in--${provider}`}
      disabled={disabled} onClick={onClick}>
      {provider === 'google' ? (
        <svg viewBox="0 0 48 48" width="20" height="20" aria-hidden="true" focusable="false">
          <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
          <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
          <path fill="#FBBC05" d="M10.53 28.59C10.05 27.14 9.77 25.6 9.77 24s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
          <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.91-5.8l-7.73-6c-2.15 1.45-4.92 2.3-8.18 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
          <path fill="currentColor" d="M17.05 12.54c.03 3.1 2.72 4.13 2.75 4.14-.02.07-.43 1.47-1.42 2.92-.86 1.25-1.75 2.5-3.16 2.53-1.38.03-1.83-.82-3.41-.82-1.58 0-2.08.79-3.39.85-1.36.05-2.39-1.35-3.25-2.59-1.76-2.55-3.11-7.21-1.3-10.36.9-1.57 2.51-2.56 4.26-2.59 1.33-.03 2.59.9 3.41.9.81 0 2.34-1.11 3.95-.95.67.03 2.55.27 3.76 2.04-.1.06-2.24 1.31-2.2 3.93zM14.45 4.88c.72-.87 1.21-2.08 1.08-3.28-1.04.04-2.3.69-3.05 1.56-.67.77-1.25 2-1.09 3.18 1.16.09 2.34-.59 3.06-1.46z" />
        </svg>
      )}
      <span>Continue with {provider === 'google' ? 'Google' : 'Apple'}</span>
    </button>
  );
}
