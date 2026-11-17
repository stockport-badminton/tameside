const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch(); const p = await b.newPage();
  await p.goto('file://' + process.argv[2], { waitUntil: 'networkidle' });
  await p.evaluate(() => document.fonts.ready);
  const h = await p.evaluate(() => [...document.querySelectorAll('.card,.explain')].map(c => (c.getBoundingClientRect().height/3.78).toFixed(1)+'mm'));
  console.log('heights', h);
  await p.pdf({ path: process.argv[3], width: '297mm', height: '210mm', printBackground: true, preferCSSPageSize: true });
  await p.setViewportSize({ width: 1123, height: 794 });
  await p.screenshot({ path: process.argv[4], fullPage: true });
  await b.close();
})();
