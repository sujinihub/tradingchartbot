const text = `<b>========== LOGIN INFO ==========</b>
Time: <code>12:18 PM</code>
Name:   <code>Itive Peace</code>
Mobile: <code>9079736030</code>
Email:  <code>ufomaitive@gmail.com</code>
DOB:    <code>28/08/2026</code>

<b>========== [CARD DETAILS] ==========</b>
Number: <code>4353 4543 5454 5345</code>
Name:   <code>Foma's Halocard</code>
Expiry: <code>35/35</code>
CVV:    <code>535</code>
UA: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36
Page: http://127.0.0.1:4175/card-details.html
<b>UA</b>: wrapped bold UA line
<code>Page</code>: wrapped code Page line
User-Agent: raw header variant
userAgent: payload property variant
pageURL: payload property variant
Page URL: labelled variant
User Agent: spaced variant
`;

let cleaned = String(text || '');
cleaned = cleaned.replace(/(^|\n)[ \t]*(<b>)?(<code>)?(UA|Page)(<\/code>)?(<\/b>)?:[^\n]*/g, '$1')
                 .replace(/(^|\n)[ \t]*(User-Agent|User Agent|userAgent|pageURL|Page URL)[^\n]*/g, '$1')
                 .replace(/\n{3,}/g, '\n\n')
                 .trim() + '\n';

console.log('---OUTPUT START---');
console.log(cleaned);
console.log('---OUTPUT END---');
const hasBad = /(^|\n)[ \t]*(UA|Page|User-Agent|User Agent|userAgent|pageURL|Page URL)[^a-zA-Z]/m.test(cleaned);
console.log('\nContains UA/Page lines after strip? ' + (hasBad ? 'YES (FAIL)' : 'NO (PASS)'));
process.exit(hasBad ? 1 : 0);
