import {test,expect} from '@playwright/test';
import {signIn} from './auth.js';

test('keeps all workspace sections usable across themes and desktop, tablet and phone layouts',async({page})=>{
  test.setTimeout(120000);const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));await signIn(page);
  const views=['Overview','Projects','Devices','Signals','Logic','Screens','Alarms','Activity','System'];
  for(const theme of ['light','dark']){
    const toggle=page.getByRole('button',{name:`Switch to ${theme} theme`,exact:true});if(await toggle.isVisible())await toggle.click();
    await expect(page.locator('html')).toHaveAttribute('data-theme',theme);
    for(const viewport of [{width:1440,height:1000},{width:768,height:1024},{width:390,height:844}]){
      await page.setViewportSize(viewport);
      for(const view of views){
        const menu=page.getByRole('button',{name:'Open navigation',exact:true});if(await menu.isVisible())await menu.click();
        await page.getByRole('button',{name:view,exact:true}).click();await expect(page.getByRole('heading',{name:view,exact:true})).toBeVisible();
        await expect(page.getByText('API connected',{exact:true})).toBeVisible();
        await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),{message:`${theme} ${view} at ${viewport.width}px should fit the page`}).toBe(true);
      }
    }
  }
  expect(errors).toEqual([]);
});

test('ignores a failed catalog response from a section that has already been left',async({page})=>{
  test.setTimeout(60000);await signIn(page);await expect(page.getByText('API connected',{exact:true})).toBeVisible();
  let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});let captured=false;
  await page.route('**/api/v1/projects',async route=>{
    if(!captured&&route.request().method()==='GET'){captured=true;await held;await route.fulfill({status:503,json:{message:'Obsolete catalog request failed'}});}
    else await route.continue();
  });
  await page.getByRole('button',{name:'Devices',exact:true}).click();await expect.poll(()=>captured).toBe(true);
  await page.getByRole('button',{name:'System',exact:true}).click();await expect(page.getByText('API connected',{exact:true})).toBeVisible();
  const response=page.waitForResponse(value=>value.status()===503&&new URL(value.url()).pathname==='/api/v1/projects');release();await (await response).finished();
  // Let the obsolete JSON rejection and its React render settle after network completion.
  await page.waitForTimeout(250);
  await expect(page.getByText('API connected',{exact:true})).toBeVisible();await expect(page.getByRole('alert')).toHaveCount(0);
});
