import axios from "axios";

// --------- EDIT THESE 4 VALUES ----------
const PRODUCT_ID = "8a36423d-e72b-49b6-825d-093a4f5ca63a";
const PHONE_ID = "69730";
const API_KEY = "7e4e95de-b845-4468-9b27-c77288314a95";
const TO_NUMBER = "+919051011177"; // must include country code
// ----------------------------------------

const TEXT = `Maytapi test message from CDC internal API.
Time: ${new Date().toISOString()}`;

async function main() {
  const url = `https://api.maytapi.com/api/${PRODUCT_ID}/${PHONE_ID}/sendMessage`;

  const payload = {
    to_number: TO_NUMBER,
    type: "text",
    message: TEXT
  };

  console.log("=== Maytapi Debug ===");
  console.log("URL:", url);
  console.log("To:", TO_NUMBER);
  console.log("Payload:", { ...payload, text: payload.message.slice(0, 80) + "..." });

  try {
    const res = await axios.post(url, payload, {
      headers: {
        "Content-Type": "application/json",
        "x-maytapi-key": API_KEY
      },
      timeout: 20000
    });

    console.log("\n✅ SUCCESS");
    console.log("Status:", res.status);
    console.log("Response:", res.data);
  } catch (err) {
    console.log("\n❌ FAILED");

    // Axios provides rich response info
    if (err.response) {
      console.log("Status:", err.response.status);
      console.log("Headers:", err.response.headers);
      console.log("Body:", err.response.data);
    } else {
      console.log("Error:", err.message);
    }
  }
}

main();