import { escapeHtml } from '../util/html.js';
import { simplePage } from '../web/simple.js';
import { MIN_PASSWORD_LENGTH } from './password.js';

export function loginPage(o: {
  formToken: string;
  next?: string;
  error?: string;
  notice?: string;
}): string {
  return simplePage(
    'Sign in',
    `<h1>Kindle Digest</h1>
${o.notice ? `<div class="msg">${escapeHtml(o.notice)}</div>` : ''}${o.error ? `<div class="msg">${escapeHtml(o.error)}</div>` : ''}
<form method="post" action="/login">
<input type="hidden" name="_csrf" value="${escapeHtml(o.formToken)}">
<input type="hidden" name="next" value="${escapeHtml(o.next ?? '')}">
<label for="username">Username</label>
<input id="username" name="username" type="text" autocapitalize="none" autocorrect="off" autocomplete="username" required>
<label for="password">Password</label>
<input id="password" name="password" type="password" autocomplete="current-password" required>
<label class="check"><input type="checkbox" name="remember" value="1"> Keep me signed in</label>
<button type="submit">Sign in</button>
</form>`,
  );
}

export function setupPage(o: { formToken: string; error?: string }): string {
  return simplePage(
    'Set a password',
    `<h1>Set a password</h1>
<p>Choose the password for the <strong>mharm</strong> account (at least ${MIN_PASSWORD_LENGTH} characters). This page disappears as soon as a password exists.</p>
${o.error ? `<div class="msg">${escapeHtml(o.error)}</div>` : ''}
<form method="post" action="/setup">
<input type="hidden" name="_csrf" value="${escapeHtml(o.formToken)}">
<label for="password">New password</label>
<input id="password" name="password" type="password" autocomplete="new-password" required>
<label for="confirm">Type it again</label>
<input id="confirm" name="confirm" type="password" autocomplete="new-password" required>
<button type="submit">Set password</button>
</form>`,
  );
}
