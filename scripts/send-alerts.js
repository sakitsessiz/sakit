/**
 * send-alerts.js
 * ------------------------------------------------------------
 * JSONBin.io-dakı avtomobil datasını oxuyur, index.html-dəki
 * "Poti & Etibarnamə Nəzarəti" panelinin EYNİ tarix/status
 * hesablama məntiqi ilə YALNIZ bu şərtə uyğun avtomobilləri
 * süzgəcdən keçirir:
 *   - c.poti tarixi mövcuddur
 *   - c.status "Bakıdadır" deyil
 *   - Poti-yə çatmasına <= 20 gün qalıb (artıq çatmışlar da daxil, days <= 0)
 *
 * Hər avtomobil üçün mailə əlavə olaraq bu iki statusu göstərir
 * (dəqiq tətbiqdəki Poti panelindəki kimi):
 *   - 📜 Etibarnamə statusu (verilib / hazır deyil)
 *   - 💵 Yol pulu statusu (ödənilib / gözlənilir)
 *
 * Uyğun avtomobil yoxdursa, mail ümumiyyətlə göndərilmir.
 *
 * Bu skript Node.js 18+ ilə işləyir (built-in fetch istifadə edir),
 * əlavə npm paketi tələb olunmur.
 * ------------------------------------------------------------
 */

const JSONBIN_BIN_ID = process.env.JSONBIN_BIN_ID;
const JSONBIN_MASTER_KEY = process.env.JSONBIN_MASTER_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const ALERT_EMAIL_TO = process.env.ALERT_EMAIL_TO;
const ALERT_EMAIL_FROM = process.env.ALERT_EMAIL_FROM || 'AuctionLand Alerts <onboarding@resend.dev>';

// CallMeBot (WhatsApp) - opsional. Əgər bu iki secret təyin olunmayıbsa,
// skript sadəcə WhatsApp göndərişini keçib yalnız mail göndərəcək.
const CALLMEBOT_PHONE = process.env.CALLMEBOT_PHONE;   // Sənin WhatsApp nömrən (beynəlxalq formatda, məs: 994501234567)
const CALLMEBOT_APIKEY = process.env.CALLMEBOT_APIKEY; // CallMeBot-dan aldığın APIKEY

// Poti-yə çatmağa neçə gün qalanda "tezliklə" hesab edilsin (tətbiqdəki SOON_20 ilə eyni)
const SOON_DAYS_THRESHOLD = 20;

function requireEnv(name, value) {
    if (!value) {
        console.error(`XƏTA: "${name}" mühit dəyişəni (secret) təyin edilməyib.`);
        process.exit(1);
    }
}

requireEnv('JSONBIN_BIN_ID', JSONBIN_BIN_ID);
requireEnv('JSONBIN_MASTER_KEY', JSONBIN_MASTER_KEY);
requireEnv('RESEND_API_KEY', RESEND_API_KEY);
requireEnv('ALERT_EMAIL_TO', ALERT_EMAIL_TO);

const whatsappEnabled = Boolean(CALLMEBOT_PHONE && CALLMEBOT_APIKEY);
if (!whatsappEnabled) {
    console.log('Diqqət: CALLMEBOT_PHONE / CALLMEBOT_APIKEY təyin olunmayıb — WhatsApp bildirişi ötürüləcək.');
}

/* ---------- Tətbiqdəki (index.html) tarix köməkçi funksiyalarının EYNİ məntiqi ---------- */

function parseAppDate(str) {
    if (!str) return null;
    let m = String(str).match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    if (m) {
        const d = parseInt(m[1], 10), mo = parseInt(m[2], 10), y = parseInt(m[3], 10);
        const dt = new Date(y, mo - 1, d);
        return isNaN(dt.getTime()) ? null : dt;
    }
    m = String(str).match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (m) {
        const y = parseInt(m[1], 10), mo = parseInt(m[2], 10), d = parseInt(m[3], 10);
        const dt = new Date(y, mo - 1, d);
        return isNaN(dt.getTime()) ? null : dt;
    }
    return null;
}

function formatDateDMY(str) {
    const dt = parseAppDate(str);
    if (!dt) return '-';
    const dd = String(dt.getDate()).padStart(2, '0');
    const mm = String(dt.getMonth() + 1).padStart(2, '0');
    const yyyy = dt.getFullYear();
    return `${dd}.${mm}.${yyyy}`;
}

function getDaysToPoti(potiDateStr) {
    const potiDate = parseAppDate(potiDateStr);
    if (!potiDate) return null;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    potiDate.setHours(0, 0, 0, 0);
    const diffTime = potiDate - today;
    return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
}

/* ---------------------------- JSONBin-dən oxu ---------------------------- */

async function fetchCarsFromCloud() {
    const url = `https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}/latest`;
    const res = await fetch(url, {
        method: 'GET',
        headers: { 'X-Master-Key': JSONBIN_MASTER_KEY }
    });

    if (!res.ok) {
        throw new Error(`JSONBin sorğusu uğursuz oldu: ${res.status} ${res.statusText}`);
    }

    const result = await res.json();
    const cars = result && result.record ? result.record : result;

    if (!Array.isArray(cars)) {
        throw new Error('JSONBin-dən gələn data massiv formatında deyil.');
    }
    return cars;
}

/* ------------------------------ Analiz məntiqi ---------------------------- */
/* index.html-dəki renderPotiTrackingList() funksiyasının EYNİ süzgəc məntiqi (SOON_20 rejimi):
   - c.poti tarixi olmalıdır
   - c.status "Bakıdadır" olmamalıdır (artıq Bakıya çatıbsa, bildirişə ehtiyac yoxdur)
   - Poti-yə çatmasına <= 20 gün qalıb (artıq çatıb - days mənfi olsa belə daxildir) */

function getPotiAlerts(cars) {
    const potiCars = cars.filter(c => c.poti && c.status !== 'Bakıdadır');

    const alerts = potiCars
        .map(c => ({ car: c, days: getDaysToPoti(c.poti) }))
        .filter(({ days }) => days !== null && days <= SOON_DAYS_THRESHOLD);

    // Tətbiqdəki kimi ən yaxın (və ya artıq keçmiş) tarixlər əvvəldə olsun
    alerts.sort((a, b) => a.days - b.days);
    return alerts;
}

/* ------------------------------- HTML şablonu ------------------------------ */

function carLabel(c) {
    return c.model || 'Naməlum avtomobil';
}

function ownerLabel(c) {
    return c.owner || '-';
}

function daysNotice(days) {
    if (days < 0) return { text: `⚠️ ${Math.abs(days)} gün əvvəl Poti-yə çatıb (Portda/Terminaldadır)`, color: '#7e22ce' };
    if (days === 0) return { text: '🚨 BU GÜN Poti-yə çatır!', color: '#e11d48' };
    if (days <= 15) return { text: `⚡ Poti-yə çatmasına cəmi ${days} gün qalıb!`, color: '#b45309' };
    return { text: `🗓️ Poti-yə çatmasına ${days} gün var`, color: '#334155' };
}

function docBadge(car) {
    // index.html-dəki "📜 Etibarnamə Statusu" bloku ilə eyni məntiq
    if (car.etibarname) {
        return { text: '✅ Verilib', color: '#047857', bg: '#ecfdf5', border: '#a7f3d0' };
    }
    return { text: '⚠️ Hazır Deyil', color: '#be123c', bg: '#fff1f2', border: '#fecdd3' };
}

function paidBadge(car) {
    // index.html-dəki "💵 Yol Pulu Statusu" bloku ilə eyni məntiq
    const amount = car.clientShipping || 0;
    if (car.shippingPaid) {
        return { text: `✅ Ödənilib ($${amount})`, color: '#047857', bg: '#ecfdf5', border: '#a7f3d0' };
    }
    return { text: `⏳ Gözlənilir ($${amount})`, color: '#92400e', bg: '#fffbeb', border: '#fde68a' };
}

function badgeHtml(b) {
    return `<span style="display:inline-block;padding:3px 10px;border-radius:9999px;font-size:11px;font-weight:700;color:${b.color};background:${b.bg};border:1px solid ${b.border};">${b.text}</span>`;
}

function renderCarRow({ car, days }) {
    const notice = daysNotice(days);
    const doc = docBadge(car);
    const paid = paidBadge(car);

    return `
        <tr>
            <td style="padding:10px 14px;border-bottom:1px solid #e2e8f0;">
                <div style="font-weight:700;color:#0f172a;">${carLabel(car)}</div>
                <div style="color:#94a3b8;font-size:11px;margin-top:2px;">👤 ${ownerLabel(car)}</div>
                <div style="color:#94a3b8;font-size:11px;font-family:monospace;">VIN: ${car.vin || '-'} ${car.container ? `| Konteyner: ${car.container}` : ''}</div>
            </td>
            <td style="padding:10px 14px;border-bottom:1px solid #e2e8f0;color:#475569;font-family:monospace;font-weight:700;">${formatDateDMY(car.poti)}</td>
            <td style="padding:10px 14px;border-bottom:1px solid #e2e8f0;color:${notice.color};font-weight:700;font-size:12px;">${notice.text}</td>
            <td style="padding:10px 14px;border-bottom:1px solid #e2e8f0;">${badgeHtml(doc)}</td>
            <td style="padding:10px 14px;border-bottom:1px solid #e2e8f0;">${badgeHtml(paid)}</td>
        </tr>`;
}

function buildEmailHtml(alerts) {
    const todayStr = new Date().toLocaleDateString('az-AZ', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const rows = alerts.map(renderCarRow).join('');
    const noDocCount = alerts.filter(a => !a.car.etibarname).length;
    const notPaidCount = alerts.filter(a => !a.car.shippingPaid).length;

    return `
    <div style="font-family:Arial,Helvetica,sans-serif;background:#f1f5f9;padding:24px;">
        <div style="max-width:760px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e2e8f0;">
            <div style="background:#0f172a;padding:20px 28px;">
                <span style="color:#fbbf24;font-size:18px;font-weight:800;">📜 AuctionLand — Poti & Etibarnamə Nəzarəti Hesabatı</span>
                <div style="color:#94a3b8;font-size:12px;margin-top:4px;">${todayStr}</div>
            </div>

            <div style="padding:20px 28px 0 28px;display:flex;gap:10px;flex-wrap:wrap;">
                <span style="display:inline-block;padding:6px 14px;border-radius:10px;font-size:12px;font-weight:700;color:#92400e;background:#fef3c7;border:1px solid #fde68a;">${alerts.length} Avtomobil (15-20 Gün Qalan / Çatmış)</span>
                <span style="display:inline-block;padding:6px 14px;border-radius:10px;font-size:12px;font-weight:700;color:#be123c;background:#ffe4e6;border:1px solid #fecdd3;">${noDocCount} Etibarnaməsi Yoxdur</span>
                <span style="display:inline-block;padding:6px 14px;border-radius:10px;font-size:12px;font-weight:700;color:#92400e;background:#fffbeb;border:1px solid #fde68a;">${notPaidCount} Yol Pulu Gözlənilir</span>
            </div>

            <div style="padding:20px 28px 24px 28px;">
                <table style="width:100%;border-collapse:collapse;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;font-size:13px;">
                    <thead>
                        <tr style="background:#f1f5f9;">
                            <th style="text-align:left;padding:10px 14px;color:#64748b;font-size:11px;text-transform:uppercase;">Avtomobil / Müştəri</th>
                            <th style="text-align:left;padding:10px 14px;color:#64748b;font-size:11px;text-transform:uppercase;">Poti Tarixi</th>
                            <th style="text-align:left;padding:10px 14px;color:#64748b;font-size:11px;text-transform:uppercase;">Vəziyyət</th>
                            <th style="text-align:left;padding:10px 14px;color:#64748b;font-size:11px;text-transform:uppercase;">Etibarnamə</th>
                            <th style="text-align:left;padding:10px 14px;color:#64748b;font-size:11px;text-transform:uppercase;">Yol Pulu</th>
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
                <p style="color:#94a3b8;font-size:11px;margin-top:20px;border-top:1px solid #e2e8f0;padding-top:14px;">
                    Bu bildiriş avtomatik olaraq GitHub Actions vasitəsilə göndərilib. Tam siyahını görmək üçün tətbiqdəki "Poti & Etibarnamə Nəzarəti" panelinə daxil olun.
                </p>
            </div>
        </div>
    </div>`;
}

/* ------------------------------- WhatsApp mətni ---------------------------- */
/* CallMeBot-un mesaj uzunluğu limiti var (uzun mesajlar kəsilir), ona görə:
   1) Hər avtomobil YIĞCAM tək sətirdə yazılır (əvvəlki 3-sətirli format yerinə)
   2) Mesaj həddindən uzun olarsa, avtomatik bir neçə hissəyə bölünüb ardıcıl
      göndərilir - beləcə say çoxalanda da heç nə kəsilmir. */

const WHATSAPP_MAX_CHARS = 1200; // Təhlükəsiz limit (CallMeBot-un praktiki kəsmə həddindən aşağı)

function shortDate(str) {
    const dt = parseAppDate(str);
    if (!dt) return '-';
    const dd = String(dt.getDate()).padStart(2, '0');
    const mm = String(dt.getMonth() + 1).padStart(2, '0');
    return `${dd}.${mm}`;
}

function compactDaysNotice(days) {
    if (days < 0) return `${Math.abs(days)}g əvvəl çatıb`;
    if (days === 0) return `BU GÜN çatır`;
    return `${days}g qalıb`;
}

function buildCarLine(index, { car, days }) {
    const doc = car.etibarname ? '✅' : '❌';
    const paid = car.shippingPaid ? '✅' : '⏳';
    return `${index}) ${carLabel(car)} (${ownerLabel(car)}) | Poti ${shortDate(car.poti)} - ${compactDaysNotice(days)} | Etib:${doc} Yol:${paid}`;
}

function buildWhatsAppHeader(alerts, part = null, totalParts = null) {
    const todayStr = new Date().toLocaleDateString('az-AZ', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const noDocCount = alerts.filter(a => !a.car.etibarname).length;
    const notPaidCount = alerts.filter(a => !a.car.shippingPaid).length;
    const partLabel = (part && totalParts && totalParts > 1) ? ` (${part}/${totalParts})` : '';
    return (
        `📜 AuctionLand Poti Nəzarəti${partLabel} - ${todayStr}\n` +
        `Cəmi:${alerts.length} Etibarnaməsiz:${noDocCount} YolPulu:${notPaidCount}\n` +
        `Etib=Etibarnamə, Yol=Yol pulu\n—————`
    );
}

// alerts-i WHATSAPP_MAX_CHARS həddini aşmayan bir neçə mətn hissəsinə bölür.
function buildWhatsAppMessages(alerts) {
    const lines = alerts.map((a, i) => buildCarLine(i + 1, a));

    // Əvvəlcə hamısını tək mesaja yerləşdirməyə cəhd et
    const singleHeader = buildWhatsAppHeader(alerts);
    const singleMsg = `${singleHeader}\n${lines.join('\n')}`;
    if (singleMsg.length <= WHATSAPP_MAX_CHARS) {
        return [singleMsg];
    }

    // Sığmırsa, sətirləri hissələrə böl (hər hissə üçün header ayrıca hesablanacaq)
    const chunks = [];
    let current = [];
    let currentLen = 0;
    const approxHeaderLen = 160; // hissə başlığı üçün ehtiyat yer

    lines.forEach(line => {
        if (currentLen + line.length + 1 > (WHATSAPP_MAX_CHARS - approxHeaderLen) && current.length > 0) {
            chunks.push(current);
            current = [];
            currentLen = 0;
        }
        current.push(line);
        currentLen += line.length + 1;
    });
    if (current.length > 0) chunks.push(current);

    return chunks.map((chunkLines, idx) => {
        const header = buildWhatsAppHeader(alerts, idx + 1, chunks.length);
        return `${header}\n${chunkLines.join('\n')}`;
    });
}

async function sendWhatsApp(text) {
    const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(CALLMEBOT_PHONE)}&text=${encodeURIComponent(text)}&apikey=${encodeURIComponent(CALLMEBOT_APIKEY)}`;
    const res = await fetch(url, { method: 'GET' });
    const bodyText = await res.text().catch(() => '');

    if (!res.ok) {
        throw new Error(`CallMeBot WhatsApp göndərilmədi: ${res.status} ${bodyText}`);
    }

    return bodyText;
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/* --------------------------------- Resend --------------------------------- */

async function sendEmail(html, subject) {
    const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${RESEND_API_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            from: ALERT_EMAIL_FROM,
            to: [ALERT_EMAIL_TO],
            subject,
            html
        })
    });

    const body = await res.json().catch(() => ({}));

    if (!res.ok) {
        throw new Error(`Resend e-poçt göndərilmədi: ${res.status} ${JSON.stringify(body)}`);
    }

    return body;
}

/* ---------------------------------- Əsas ---------------------------------- */

async function main() {
    console.log('JSONBin-dən data çəkilir...');
    const cars = await fetchCarsFromCloud();
    console.log(`${cars.length} avtomobil oxundu.`);

    const alerts = getPotiAlerts(cars);
    console.log(`Poti bildirişi tələb edən avtomobil sayı: ${alerts.length}`);

    if (alerts.length === 0) {
        console.log('Heç bir aktiv Poti bildirişi yoxdur — e-poçt göndərilmir.');
        return;
    }

    const html = buildEmailHtml(alerts);
    const subject = `⚠️ Poti Bildirişi: ${alerts.length} avtomobil diqqət tələb edir`;

    console.log('E-poçt göndərilir...');
    await sendEmail(html, subject);
    console.log('E-poçt uğurla göndərildi!');

    if (whatsappEnabled) {
        try {
            console.log('WhatsApp bildirişi göndərilir...');
            const waMessages = buildWhatsAppMessages(alerts);
            console.log(`WhatsApp mesajı ${waMessages.length} hissəyə bölündü.`);
            for (let i = 0; i < waMessages.length; i++) {
                await sendWhatsApp(waMessages[i]);
                console.log(`WhatsApp hissəsi ${i + 1}/${waMessages.length} göndərildi.`);
                // CallMeBot ardıcıl sürətli sorğuları rədd edə bilər - araya kiçik fasilə qoyuruq
                if (i < waMessages.length - 1) await sleep(3000);
            }
            console.log('WhatsApp bildirişi uğurla göndərildi!');
        } catch (waErr) {
            // WhatsApp uğursuz olsa belə, mail artıq göndərilib - skript xəta ilə dayanmasın
            console.error('WhatsApp göndərilmədi (mail buna baxmayaraq göndərilib):', waErr.message);
        }
    }
}

main().catch(err => {
    console.error('Skript xəta ilə dayandı:', err.message);
    process.exit(1);
});
