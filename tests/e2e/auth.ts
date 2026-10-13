import { test, type Page } from '@playwright/test';

/** Exercise real browser login while respecting the shared fixture's production rate limit. */
export async function signIn(page: Page, password='E2E fixture password only!') {
  await page.goto('/');
  await page.getByLabel('Username',{exact:true}).fill('operator');
  await page.getByLabel('Password',{exact:true}).fill(password);
  for(let attempt=0;attempt<2;attempt++) {
    const pending=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/v1/auth/login'&&response.request().method()==='POST');
    await page.getByRole('button',{name:'Sign in',exact:true}).click();
    const response=await pending;
    if(response.status()!==429)return;
    const seconds=Number(response.headers()['retry-after']);
    if(!Number.isInteger(seconds)||seconds<1||seconds>60)throw new Error('Unexpected login rate-limit window');
    const delay=(seconds+1)*1000;
    test.setTimeout(test.info().timeout+delay+5000);
    await page.waitForTimeout(delay);
  }
  throw new Error('Login remained rate-limited after its Retry-After window');
}
