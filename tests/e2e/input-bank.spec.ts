import {expect,test} from '@playwright/test';
import {signIn} from './auth.js';
test('creates a multichannel bank, monitors its inputs, and disconnects every channel on stop',async({page})=>{
  const projectName=`Input bank ${Date.now()}`;
  await signIn(page);
  await page.getByRole('button',{name:'Projects',exact:true}).click();
  await page.getByLabel('Project name',{exact:true}).fill(projectName);
  await page.getByRole('button',{name:'Create project',exact:true}).click();
  await page.getByRole('link',{name:`Open ${projectName}`,exact:true}).click();
  await page.getByRole('button',{name:'Open devices',exact:true}).click();
  await page.getByLabel('Device name',{exact:true}).fill('Bench bank');
  await page.getByRole('combobox',{name:'Device profile',exact:true}).selectOption('virtual-input-bank');
  await page.getByLabel('Numeric inputs',{exact:true}).fill('15');
  await page.getByLabel('Site ID',{exact:true}).fill('bank-browser');
  await page.getByLabel('Device address',{exact:true}).fill('bank');
  await page.getByRole('button',{name:'Add device',exact:true}).click();
  const card=page.getByRole('article').filter({hasText:'Bench bank'});
  await card.getByRole('button',{name:'Start simulator',exact:true}).click();
  await expect(card.getByText('Simulation running',{exact:true})).toBeVisible();
  try {
    await page.getByRole('button',{name:'Signals',exact:true}).click();
    const rows=page.getByRole('row').filter({hasText:'Bench bank.'});
    await expect(rows).toHaveCount(16);
    const input=rows.filter({hasText:'Bench bank.input-15'});
    await expect(input).toContainText('Good');
    await expect(input.getByRole('button',{name:'Control',exact:true})).toBeDisabled();
    const value=await input.locator('.signal-value').innerText();
    await expect(input.locator('.signal-value')).not.toHaveText(value);
  } finally {
    await page.getByRole('button',{name:'Devices',exact:true}).click();
    await card.getByRole('button',{name:'Stop simulator',exact:true}).click();
    await expect(card.getByText('Simulation stopped',{exact:true})).toBeVisible();
  }
  await page.getByRole('button',{name:'Signals',exact:true}).click();
  const inputs=page.getByRole('row').filter({hasText:'Bench bank.input-'});
  await expect(inputs).toHaveCount(15);
  for(const row of await inputs.all()) await expect(row).toContainText('Disconnected');
});
