# دليل عرض المشروع على Upwork

## 1. أضِفه إلى المعرض (Portfolio)

1. في Upwork افتح: **Profile → Portfolio → Add project** (+).
2. **Title:** `Aave Position Guardian – DeFi Liquidation Alert Bot & Dashboard`
3. **Your role:** `Full-stack developer (TypeScript, Web3)`
4. **Project description:** انسخ "Short version" أو "Full version" من [PROJECT-DESCRIPTION.md](PROJECT-DESCRIPTION.md).
5. **Skills:** اختر 5 مهارات من قائمة "Skills / tags" في الملف نفسه، مثل TypeScript وWeb3 وTelegram Bot وNext.js وNode.js.
6. **Content (الوسائط)** بهذا الترتيب:
   - صورة غلاف: لقطة للوحة فيها المراكز بالألوان. هذه أول ما يراه العميل.
   - صورة للرسم البياني لـ HF مع خطوط العتبات.
   - صورة لتنبيهات تيليجرام. قبل رفعها تأكد أنها **لا تُظهر اسمك الشخصي أو أي توكن**.
   - الفيديو (60 ثانية) من [VIDEO-SCRIPT.md](VIDEO-SCRIPT.md). ارفعه على YouTube كـ Unlisted وضع الرابط.
   - رابط العرض المباشر: https://aave-position-guardian.vercel.app
   - رابط GitHub، **بعد** أن تجعل المستودع عامًا (انظر القسم 3).

## 2. كيف تتكلم عنه مع العملاء (بصدق)

**قل:**
- "بنيتُ نظام مراقبة للقراءة فقط لمقترضي Aave V3 على 4 شبكات، مع تنبيهات تيليجرام ولوحة تحكم."
- "اختبرتُه بـ 152 اختبارًا آليًا، وقارنتُ قراءاته بعقد Aave نفسه على fork: 64 من 64 فحصًا نجحت."
- "استخدمتُ مساعد برمجة بالذكاء الاصطناعي وأنا أوجّه العمل وأراجع كل مرحلة وأختبرها بنفسي."

**لا تقل أبدًا:**
- "مُدقَّق أمنيًا (audited)"، أو "جاهز للإنتاج"، أو "يمنع التصفية بشكل مضمون".
- أرقامًا لم تخرج من الاختبارات، مثل عدد مستخدمين أو أموال محمية.

**جملة جاهزة لطلبات العمل (Proposals) بالإنجليزية:**

> I recently built Aave Position Guardian, a read-only monitor that reads Aave V3 positions on four
> networks via Multicall3 and sends deduplicated Telegram alerts, with a Next.js dashboard. I validated
> it against Aave's own contract on mainnet forks (64/64 checks). Demo: https://aave-position-guardian.vercel.app

## 3. قبل جعل المستودع عامًا

المستودع الآن **خاص**. قبل جعله عامًا:
1. شغّل الفحص الكامل وتأكد أن النتيجة نظيفة:
   ```powershell
   npm run scan:all
   ```
2. راجع [SECURITY-CHECKLIST.md](../SECURITY-CHECKLIST.md) بندًا بندًا.
3. بعد ذلك فقط: في GitHub افتح **Settings → General → Danger Zone → Change visibility → Public**.

## 4. أنواع الوظائف المناسبة للبحث

- Telegram bot development، وخصوصًا بوتات التنبيهات والمراقبة.
- Web3 / DeFi dashboards (قراءة بيانات من البلوكتشين).
- Node.js / TypeScript backend، وواجهات API.
- Next.js dashboards مع رسوم بيانية.

ابدأ بمشاريع صغيرة وواضحة في هذه المجالات. ابتعد عن أي عمل يطلب منك التعامل مع مفاتيح خاصة لأموال
العملاء، أو كتابة عقود ذكية ستُدار بها أموال حقيقية، قبل أن تكتسب خبرة ومراجعة أمنية مستقلة.
