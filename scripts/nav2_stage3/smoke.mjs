import { api, USERS, logoutAll, PORT } from './_lib.mjs';
console.log('port', PORT);
for (const k of ['holder', 'free']) {
  const r = await api(USERS[k], 'GET', '/api/reports/fund-analytics');
  console.log(k, r.status, r.text.slice(0, 200));
}
const own = await api(USERS.holder, 'POST', '/api/ownership/self');
console.log('self', own.status, own.text.slice(0, 200));
await logoutAll();
