# שלהבת מחטבת

אתר נחיתה דו־לשוני של **שלהבת מחטבת** – ליווי אישי אונליין בכושר ובתזונה לנשים.

- אנגלית: <https://shalhevetmehatevet.com/>
- עברית: <https://shalhevetmehatevet.com/he>

האתר סטטי (HTML, CSS ו־JavaScript רגילים, בלי שלב build) ומוגש מ־Cloudflare Workers. Worker קטן מקבל את טופס יצירת הקשר, שולח אותו לשלהבת במייל ומוסיף כותרות אבטחה ומטמון לכל תשובה.

## מבנה התיקיות

```
public/                      האתר עצמו. כל מה שכאן עולה לאוויר כמו שהוא
  index.html                 דף הבית באנגלית              /
  he/index.html              דף הבית בעברית               /he
  privacy.html               מדיניות פרטיות               /privacy       (עברית: he/privacy.html)
  accessibility.html         הצהרת נגישות                 /accessibility (עברית: he/accessibility.html)
  404.html                   דף "לא נמצא"
  robots.txt, sitemap.xml    למנועי חיפוש
  favicon.ico, site.webmanifest
  assets/css/styles.css      גיליון עיצוב אחד לשתי השפות ולכל הדפים
  assets/js/main.js          הסקריפט של האתר (תפריט, טופס, כפתורים)
  assets/js/analytics.js     Matomo
  assets/fonts/              הגופן Heebo, מאוחסן אצלנו
  assets/img/                תמונות, לוגו, אייקונים ותמונות שיתוף
src/worker.js                ה־Worker: טופס הלידים, הפניות, כותרות אבטחה ומטמון
wrangler.jsonc               הגדרות Cloudflare
```

כתובות בלי סיומת ובלי לוכסן בסוף: `public/he/privacy.html` מוגש ב־`/he/privacy`.

## פיתוח מקומי

```bash
npm install
npm run dev      # http://localhost:8787
```

- מקומית הטופס עובד מקצה לקצה גם בלי מייל: כשאין `LEAD_TO`, הליד נכתב ללוג של wrangler והתשובה היא הצלחה. הגבלת הקצב כבויה.
- לבדיקת מסך השגיאה: בקשה ל־`/api/lead` עם הכותרת `X-Test-Fail: 1` מחזירה 502. עובד רק ב־localhost.
- לבדיקת המייל עצמו: קובץ `.dev.vars` (לא נכנס ל־git) עם השורה `LEAD_TO=someone@example.com`. שום דבר לא נשלח באמת; wrangler שומר את ההודעה כקובץ `.eml` ומדפיס את הנתיב.
- `npm run check` בודק את הקוד וההגדרות בלי להעלות (`wrangler deploy --dry-run`).

## העלאה לאוויר

```bash
npx wrangler login   # פעם אחת
npm run deploy       # wrangler deploy
```

מאגר ה־KV של הגיבוי (`shalhevet-mehatevet-leads`) כבר נוצר, וה־id שלו רשום ב־`wrangler.jsonc`.

כתובת ה־`*.workers.dev` נשארת פעילה לתצוגה מקדימה, וה־Worker מסמן אותה `noindex`.

### פעם אחת, לפני שהטופס יכול לשלוח מיילים

1. ב־Cloudflare, בדומיין `shalhevetmehatevet.com`: להפעיל **Email Routing**. שימו לב שזה מחליף את רשומות ה־MX של הדומיין.
2. ב־Email Routing › Destination addresses: להוסיף כל כתובת שצריכה לקבל לידים, ולאשר אותה מהמייל שנשלח אליה. בחשבון חינמי אפשר לשלוח רק לכתובות מאומתות.
3. `npx wrangler secret put LEAD_TO` ולהדביק את הכתובות (ראו "הגדרות").
4. לשלוח ליד אמיתי מהאתר ולוודא שהמייל הגיע.

### חיבור הדומיין

הדומיין כבר מחובר (אוקטובר 2026): הדומיין נמצא ב־Cloudflare (שרתי השמות ב־Namecheap מצביעים אליו), ה־routes שלמטה כבר ב־`wrangler.jsonc`, ו־Always Use HTTPS מופעל. הצעדים נשארים כאן לתיעוד.

1. ב־`wrangler.jsonc`:

   ```jsonc
   "routes": [
     { "pattern": "shalhevetmehatevet.com", "custom_domain": true },
     { "pattern": "www.shalhevetmehatevet.com", "custom_domain": true }
   ],
   "dev": { "host": "localhost" }
   ```

   - גם `www` חייב להגיע ל־Worker: הוא זה שמפנה אותו (301) לדומיין הראשי.
   - השורה `dev.host` נחוצה מרגע שיש `routes`: בלעדיה `wrangler dev` מציג ל־Worker את שם הדומיין האמיתי, וההתנהגות המקומית (טופס בלי מייל, בלי HSTS) מפסיקה לעבוד.

2. **חובה:** להפעיל ב־Cloudflare את **Always Use HTTPS** לדומיין (SSL/TLS › Edge Certificates). ה־Worker לא מפנה בעצמו מ־http ל־https, ובכתובת http הטופס לא עובד: השליחה נדחית (403) והגולשת רואה רק את ההצעה לשלוח בוואטסאפ. בדיקה אחרי ההפעלה: `curl -sI http://shalhevetmehatevet.com/` מחזיר 301 לכתובת ה־https.


### איזה קישור משתפים

בביו של האינסטגרם, בפרופיל הוואטסאפ העסקי, בפוסטים ובמודעות בעברית משתמשים תמיד ב־`https://shalhevetmehatevet.com/he`, ולא בדומיין לבדו.

הדומיין לבדו (`https://shalhevetmehatevet.com/`) הוא העמוד באנגלית, בלי קשר לשפה של הגולשת: התצוגה המקדימה של הקישור (כותרת ותמונה) תהיה באנגלית, והיא תנחת בעמוד האנגלי. ההצעה "האתר זמין גם בעברית" מופיעה שם רק כשהדפדפן שלה מוגדר לעברית ו־JavaScript פועל.

## איפה עורכים טקסטים

| מה | איפה |
|---|---|
| כל הטקסטים שבדפים, כולל הודעות הטופס | ישירות ב־HTML: `public/index.html` (אנגלית), `public/he/index.html` (עברית). כל שינוי עושים בשתי השפות |
| שאלות נפוצות | מופיעות פעמיים בכל דף: בגוף הדף ובבלוק ה־JSON-LD שב־`<head>`. לעדכן את שניהם |
| כותרת, תיאור ותמונת שיתוף | תגיות ה־meta ב־`<head>` של כל דף |
| מדיניות פרטיות והצהרת נגישות | `public/privacy.html`, `public/accessibility.html` והמקבילים ב־`public/he/` |
| דפי התשובה לטופס שנשלח בלי JavaScript | `src/worker.js`, האובייקט `TEXT` |
| המייל ששלהבת מקבלת | `src/worker.js`, הפונקציה `buildLeadEmail` |

דף חדש צריך להיכנס גם ל־`public/sitemap.xml`.

## איך הטופס עובד, מקצה לקצה

1. הגולשת ממלאת שם, טלפון, תוכנית והערה, ומסמנת הסכמה.
2. `main.js` בודק את השדות ושולח JSON ל־`POST /api/lead`. בלי JavaScript הטופס נשלח כטופס רגיל, וה־Worker עונה בדף HTML קטן בשפת הטופס.
3. ה־Worker בודק לפי הסדר: מקור הבקשה (`Origin`), גודל (עד 10KB), הגבלת קצב (5 שליחות בדקה לכתובת IP), שדה מלכודת לבוטים ושליחה מהירה מדי (פחות מ־1.5 שניות), ואז את תקינות השדות.
4. עותק גיבוי נשמר ב־KV ל־90 יום. כתובת ה־IP לא נשמרת.
5. נשלח מייל בעברית לכל כתובת שב־`LEAD_TO`: שם, טלפון עם קישור חיוג וקישור לוואטסאפ, התוכנית, ההערה, שפת העמוד והשעה בישראל.
6. התשובה היא הצלחה רק אם לפחות מייל אחד התקבל למשלוח. אחרת חוזר 502, והאתר מציע לגולשת לשלוח את הפרטים בוואטסאפ בלחיצה אחת. ההודעה לוואטסאפ כבר מכילה את מה שהיא מילאה, גם בדף התשובה שמוצג בלי JavaScript.
7. אותה הצעה מוצגת גם כשאין תשובה מהשרת: `main.js` מוותר על בקשה שנתקעת אחרי 25 שניות.

מקורות (`Origin`) שהטופס מקבל: הדומיין עצמו ו־`www`; כתובת `*.workers.dev` רק כשהיא הכתובת של ה־Worker הזה עצמו (תצוגה מקדימה ששולחת לעצמה); `http://localhost` ו־`http://127.0.0.1` רק בפיתוח מקומי.

| תשובה | מתי |
|---|---|
| `200 {"ok":true}` | הליד נשלח. גם כשבוט נתפס (בלי לשלוח כלום) |
| `400 {"ok":false,"error":"validation","fields":{...}}` | שדה חסר או לא תקין |
| `429 rate_limited` | יותר מ־5 שליחות בדקה מאותה כתובת |
| `502 delivery` | המייל לא נשלח (הגיבוי ב־KV כן נשמר) |
| `403` / `405` / `413` / `415` | מקור זר / לא POST / גוף גדול מדי / סוג תוכן לא נתמך |

## הגדרות

| שם | סוג | הסבר |
|---|---|---|
| `LEAD_TO` | secret | למי נשלחים הלידים: רשימת כתובות מופרדות בפסיקים, עד 5. כל כתובת חייבת להיות Destination address **מאומתת** ב־Email Routing. לא נשמר ב־git. ערך שאינו כתובת תקינה לא נשלח אליו כלום, ובלוג נרשמת השורה `LEAD_TO: ... ignored` (מספר הערכים בלבד) |
| `LEAD_FROM` | var ב־`wrangler.jsonc` | כתובת השולח, `leads@shalhevetmehatevet.com`. חייבת להיות בדומיין שמופעל בו Email Routing |
| `EMAIL` | binding מסוג `send_email` | שליחת המייל |
| `LEADS` | KV | גיבוי הלידים ל־90 יום |
| `LEAD_LIMITER` | binding מסוג `ratelimits` | הגבלת הקצב. ה־`namespace_id` הוא מספר כלשהו, ייחודי בחשבון |

```bash
# עדכון הנמענים
npx wrangler secret put LEAD_TO
#   לדוגמה: first@example.com, second@example.com

# צפייה בגיבוי
npx wrangler kv key list --binding LEADS --remote --prefix "lead:"
npx wrangler kv key get  --binding LEADS --remote --text "lead:2026-10-12T13:07:00.000Z:ab12cd34"

# לוגים חיים
npm run tail
```

בלוגים של הייצור נרשמת רק התוצאה (נשלח / נכשל / נחסם) ומפתח הגיבוי. שמות, טלפונים והערות לא נכתבים ללוג. אם שלהבת אומרת שמייל לא הגיע: מחפשים בלוג `"outcome":"failed"` ושולפים את הליד מהגיבוי לפי המפתח.

## קישור האינסטגרם

כתובת האינסטגרם עוד לא הוזנה. כל קישור לאינסטגרם ב־HTML מסומן `data-instagram`, מוסתר עם התכונה `hidden`, ומצביע בינתיים לכתובת ניטרלית (`https://www.instagram.com/`) כדי שסורקים לא ייתקלו בקישור שבור. יש 8 קישורים כאלה ב־6 קבצים (שניים בכל דף בית, אחד בכל דף פרטיות ונגישות).

כשהכתובת ידועה:

1. בכל קישור שמסומן `data-instagram` (חיפוש: `grep -rn "data-instagram" public/`): להחליף את ה־`href` בכתובת הפרופיל המלאה, למשל `https://www.instagram.com/<שם_המשתמש>/`.
2. למחוק מאותם קישורים את התכונה `hidden`.
3. אפשר להוסיף את הכתובת גם ל־`sameAs` ב־JSON-LD של דפי הבית.
4. `npm run deploy`.

## אנליטיקס

האתר משתמש ב־Matomo שמאוחסן אצל מפתח האתר (`matomo.alphalockandsafe.com`, אתר מספר 2). `analytics.js` נטען רק כשהכתובת היא `shalhevetmehatevet.com`, כך ש־localhost וכתובות התצוגה המקדימה לא מלכלכים את הנתונים. אין פיקסל `<noscript>`.

**לבדוק:** נכון לאוקטובר 2026 שרת ה־Matomo מחזיר 400 לכל בקשת מעקב עם אתר מספר 2 (כמו לאתר שלא קיים), כך שביקורים לא נרשמים. צריך לוודא ב־Matomo מה מספר האתר הנכון (או ליצור אתר חדש לכתובת `shalhevetmehatevet.com`) ולעדכן את `setSiteId` ב־`analytics.js`.

ה־Web Analytics (RUM) של Cloudflare כבוי לדומיין בכוונה: הוא מזריק סקריפט שה־CSP חוסם, ומדיניות הפרטיות מציינת רק את Matomo.

אם כתובת ה־Matomo משתנה, מעדכנים בשני מקומות: `public/assets/js/analytics.js` וה־Content-Security-Policy שב־`src/worker.js`. ה־CSP חוסם כל סקריפט, עיצוב או בקשה שלא מהאתר עצמו או מ־Matomo, ולכן אין להוסיף ל־HTML סקריפטים או עיצוב inline.

## פרטי קשר שמופיעים באתר

- וואטסאפ וטלפון: `054-2213199`
- מייל (בדפי הפרטיות והנגישות בלבד): `Shely.siyonov1@gmail.com`
