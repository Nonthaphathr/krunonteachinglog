/* Service worker แบบเรียบง่าย: ทำให้ติดตั้งเป็นแอปบนหน้าจอโฮมได้ ไม่แคชข้อมูล (ข้อมูลอยู่ที่ Firestore เสมอ) */
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', function (e) {
  if (e.request.mode !== 'navigate') return;
  e.respondWith(fetch(e.request).catch(function () {
    return new Response('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:sans-serif;text-align:center;padding:40px;color:#1f3a5f"><h2>ไม่มีสัญญาณอินเทอร์เน็ต</h2><p>เปิดแอปอีกครั้งเมื่อเชื่อมต่อเครือข่ายแล้ว</p>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }));
});
