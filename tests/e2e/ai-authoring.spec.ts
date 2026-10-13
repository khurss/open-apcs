import {test,expect} from '@playwright/test';
import {signIn} from './auth.js';
test.use({actionTimeout:5000});
test('reviews AI graph and screen proposals before applying them to unsaved drafts',async({page})=>{
  test.setTimeout(120000);await signIn(page);
  await page.getByRole('button',{name:'Projects',exact:true}).click();await page.getByLabel('Project name',{exact:true}).fill('AI authoring fixture');await page.getByRole('button',{name:'Create project',exact:true}).click();
  await page.getByRole('link',{name:'Open AI authoring fixture',exact:true}).click();
  for(const [section,kind] of [['Logic','graph'],['Screens','screen']] as const){
    await page.getByRole('button',{name:section,exact:true}).click();await page.getByLabel('Scheme name',{exact:true}).fill(`AI ${kind}`);await page.getByRole('button',{name:`Create ${kind}`,exact:true}).click();
    await page.getByRole('button',{name:'AI assistant',exact:true}).click();const assistant=page.getByRole('region',{name:'AI draft assistant',exact:true});
    await assistant.getByLabel('Draft requirements',{exact:true}).fill(kind==='graph'?'A constant that starts disabled':'A welcoming overview label');
    await expect(assistant.getByRole('button',{name:'Generate proposal',exact:true})).toBeDisabled();
    await assistant.getByRole('checkbox').last().check();await assistant.getByRole('button',{name:'Generate proposal',exact:true}).click();
    const preview=assistant.getByRole('region',{name:'AI proposal preview',exact:true});await expect(preview).toContainText('Fixture proposal');
    await expect(page.getByRole('button',{name:'Save draft',exact:true})).toBeDisabled();
    page.once('dialog',dialog=>dialog.accept());await preview.getByRole('button',{name:'Apply proposal to draft',exact:true}).click();
    await expect(page.getByRole('button',{name:'Save draft',exact:true})).toBeEnabled();
    await expect(page.getByRole('button',{name:kind==='graph'?'Select AI constant':'Select AI overview',exact:true})).toBeVisible();
    await page.getByRole('button',{name:'Undo',exact:true}).click();await expect(page.getByRole('button',{name:'Save draft',exact:true})).toBeDisabled();
    await page.getByRole('button',{name:'Redo',exact:true}).click();await page.getByRole('button',{name:'Save draft',exact:true}).click();await expect(page.getByRole('button',{name:'Save draft',exact:true})).toBeDisabled();
    await page.route('**/api/v1/projects/*/ai/proposals',route=>route.fulfill({status:502,json:{message:'AI provider unavailable'}}));
    await assistant.getByRole('button',{name:'Generate proposal',exact:true}).click();await expect(assistant.getByRole('alert')).toContainText('AI provider unavailable');
    await expect(page.getByRole('button',{name:'Save draft',exact:true})).toBeDisabled();await page.unroute('**/api/v1/projects/*/ai/proposals');
  }
});
