const { waApiToken, waApiUrl, waSender } = require("../config");

async function sendWhatsAppMessage(to, message) {
  if (!to) return { sent: false, reason: "Nomor WA kosong." };
  if (!waApiUrl || !waApiToken) {
    return { sent: false, reason: "WA API belum dikonfigurasi (.env)." };
  }

  const payload = { to, message };
  if (waSender) payload.sender = waSender;

  try {
    const response = await fetch(waApiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${waApiToken}`
      },
      body: JSON.stringify(payload)
    });
    const body = await response.text();
    return {
      sent: response.ok,
      statusCode: response.status,
      response: body
    };
  } catch (error) {
    return { sent: false, reason: error.message };
  }
}

module.exports = { sendWhatsAppMessage };
