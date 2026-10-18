# אתר מתמטיקה לצוות השש שנתי – שרית סמואל

האתר (במקור ממוזלו) עם עורך חי שמשותף לכל הדפים.

| קובץ / תיקייה | מה זה |
|---|---|
| `index.html`, `page-*/`, `--3/`, `httpsexamseducationgovil/` | דפי האתר |
| `assets/site.js` | נטען בכל דף. מוסיף את 🔒 בתחתית, ואת העורך טוען רק למנחה |
| `assets/editor.js`, `assets/editor.css` | העורך החי |
| `assets/templates.json` | השבלונות. מתעדכן מתוך העורך בכל פרסום |
| `feedback.html` | לוח בקשות ל-Claude לכל הדפים |

## העלאה ל-GitHub Pages (פעם אחת)
1. ב-GitHub: **New repository**, למשל `math-site`, **Public**, בלי README.
2. מהטרמינל, בתיקייה הזו:
   ```bash
   git remote add origin https://github.com/<USER>/math-site.git
   git push -u origin main
   ```
   או בממשק של GitHub: **uploading an existing file** ← גוררים את כל תוכן התיקייה.
3. **Settings ← Pages** ← Source: `Deploy from a branch`, Branch: `main` / `(root)` ← **Save**.
4. אחרי כדקה האתר זמין בכתובת `https://<USER>.github.io/math-site/`.

## עריכה חיה
- נכנסים דרך 🔒 בתחתית כל דף, או `#admin` בסוף הכתובת, או `Ctrl+Shift+E`. שם משתמש: `SARIT`.
- **לחיצה** על רכיב בוחרת אותו. **לחיצה כפולה** עורכת את הטקסט. **גרירה** משנה את סדר הכרטיסים והקטגוריות. **Alt+לחיצה** משתמשת בדף כרגיל.
- כל שינוי נשמר אוטומטית כטיוטה בדפדפן. הגולשים רואים אותו רק אחרי 🚀 פרסום.
- **פרסום ישיר:** ⚙️ ← מדביקים Fine-grained token (רק למאגר הזה, הרשאה Contents: Read and write) ← 🚀.
- **בלי טוקן:** "⬇ HTML" מוריד את הדף. מעלים אותו ל-GitHub לאותו נתיב.

> שם המשתמש רק מסתיר את כלי העריכה. הוא לא סיסמה, כי קוד האתר גלוי לכולם.
> מה שמגן על האתר: רק מי שיש לו גישה למאגר ב-GitHub (או טוקן) יכול לשנות אותו.

## עבודה מקומית
העורך צריך לקרוא את קוד המקור של הדף, ולכן לא עובד כשפותחים קובץ ישירות (`file://`). מריצים:
```bash
python3 -m http.server 8000
```
ופותחים `http://localhost:8000`.
