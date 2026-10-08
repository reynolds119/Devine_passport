import { invokeFunction, supabase } from "./supabase.js";
import { $, esc, toast } from "./utils.js";

const form = $("#donate-form");
const amount = $("#amount");
const result = $("#give-result");
const wireDetails = $("#wire-details");
const wireCurrency = $("#wire-currency");
const wireCurrencyWrap = $("#wire-currency-wrap");
const wireMethod = $("#wire-payment-method");
const wireAvailability = $("#wire-availability");
const verifyAgain = $("#verify-again");
const wireReportForm = $("#wire-report-form");
let activeReference = null;
let wireAccounts = [];

for (const button of document.querySelectorAll("[data-amount]")) {
  button.addEventListener("click", () => {
    amount.value = button.dataset.amount;
    for (const option of document.querySelectorAll("[data-amount]")) {
      option.setAttribute("aria-pressed", String(option === button));
    }
  });
}

amount.addEventListener("input", () => {
  for (const option of document.querySelectorAll("[data-amount]")) {
    option.setAttribute("aria-pressed", String(option.dataset.amount === amount.value));
  }
});

function paymentMethod() {
  return document.querySelector('input[name="payment_method"]:checked')?.value || "paystack";
}

function updatePaymentForm() {
  const isWire = paymentMethod() === "bank_transfer";
  const currency = wireCurrency.selectedOptions[0]?.dataset.currency || "USD";
  wireCurrencyWrap.hidden = !isWire;
  wireCurrency.required = isWire;
  $("#ghs-quick-amounts").hidden = isWire;
  $("#amount-label").textContent = `Amount in ${isWire ? currency : "GHS"}`;
  $("#payment-note").textContent = isWire
    ? "Bank transfers are checked manually. Your gift is recorded after funds arrive and an admin confirms receipt."
    : "Paystack hosts checkout. Your payment details are never entered on this site; overseas card providers convert to GHS.";
  $("#checkout").textContent = isWire ? "Show bank instructions" : "Continue to secure checkout";
}

for (const method of document.querySelectorAll('input[name="payment_method"]')) {
  method.addEventListener("change", updatePaymentForm);
}
wireCurrency.addEventListener("change", updatePaymentForm);

async function loadWireAccounts() {
  let accounts;
  try {
    const { data, error } = await supabase.from("donation_bank_accounts").select("id,currency").eq("is_active", true).order("currency");
    if (error) throw error;
    accounts = data;
  } catch (error) {
    wireMethod.disabled = true;
    wireAvailability.textContent = "International bank instructions are not available yet.";
    wireCurrency.replaceChildren(new Option("No bank accounts configured", ""));
    toast(error.message, "error");
    return;
  }

  wireAccounts = accounts || [];
  wireCurrency.replaceChildren(...wireAccounts.map((account) => {
    const option = new Option(account.currency, account.id);
    option.dataset.currency = account.currency;
    return option;
  }));
  wireMethod.disabled = wireAccounts.length === 0;
  if (wireAccounts.length === 0) {
    wireCurrency.replaceChildren(new Option("No bank accounts configured", ""));
    wireAvailability.textContent = "International bank instructions are not available yet.";
  } else {
    wireAvailability.textContent = "Transfers are reviewed manually before being confirmed.";
  }
  updatePaymentForm();
}

function showResult(title, message, canRetry = false) {
  form.hidden = true;
  wireDetails.hidden = true;
  result.hidden = false;
  $("#result-title").textContent = title;
  $("#result-message").textContent = message;
  verifyAgain.hidden = !canRetry;
}

function formatGhs(amountMinor) {
  return new Intl.NumberFormat("en-GH", { style: "currency", currency: "GHS" }).format(amountMinor / 100);
}

function formatCurrency(amount, currency) {
  return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amount);
}

async function verifyPayment(reference) {
  activeReference = reference;
  showResult("Checking your payment", "Please wait while we confirm it with Paystack.", false);
  try {
    const data = await invokeFunction("verify-donation", { reference });

    if (data.status === "success") {
      showResult("Thank you for your gift", `${formatGhs(data.amount_minor)} has been confirmed.`, false);
    } else if (data.status === "failed") {
      showResult("Payment not completed", "No completed payment was found. Please try checkout again.", false);
    } else {
      showResult("Payment is processing", "We have not confirmed this gift yet. Check again shortly.", true);
    }
  } catch (error) {
    showResult("Could not confirm payment", error.message || "Please try again in a moment.", true);
  }
}

function showWireInstructions(data) {
  const account = data.bank_account;
  form.hidden = true;
  result.hidden = true;
  wireDetails.hidden = false;
  wireDetails.dataset.reference = data.reference;
  $("#wire-amount").textContent = `Send ${formatCurrency(data.amount, data.currency)}. Use donation reference ${data.reference} in your transfer description.`;
  const details = [
    ["Beneficiary", account.beneficiary_name],
    ["Bank", account.bank_name],
    ["Account number", account.account_number],
    ["IBAN", account.iban],
    ["SWIFT / BIC", account.swift_bic],
    ["Routing number", account.routing_number],
    ["Bank address", account.bank_address],
    ["Instructions", account.payment_instructions],
    ["Donation reference", data.reference],
  ].filter(([, value]) => value);
  $("#wire-bank-details").innerHTML = details.map(([label, value]) => `<dt>${esc(label)}</dt><dd>${esc(value)}</dd>`).join("");
  $("#wire-report-message").textContent = "";
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("#checkout");
  button.disabled = true;
  const isWire = paymentMethod() === "bank_transfer";
  button.textContent = isWire ? "Loading bank instructions…" : "Opening secure checkout…";

  try {
    if (isWire) {
      const account = wireAccounts.find((item) => item.id === wireCurrency.value);
      if (!account) throw new Error("Choose an available transfer currency.");
      const data = await invokeFunction("create-wire-transfer", {
          account_id: account.id,
          currency: account.currency,
          amount: Number(amount.value),
          email: $("#donor-email").value.trim(),
          donor_name: $("#donor-name").value.trim(),
        });
      showWireInstructions(data);
    } else {
      const data = await invokeFunction("initialize-donation", {
          amount: Number(amount.value),
          email: $("#donor-email").value.trim(),
          donor_name: $("#donor-name").value.trim(),
        });

      const checkoutUrl = new URL(data.authorization_url);
      if (checkoutUrl.protocol !== "https:" || checkoutUrl.hostname !== "checkout.paystack.com") {
        throw new Error("Paystack returned an invalid checkout link.");
      }
      window.location.assign(checkoutUrl.href);
    }
  } catch (error) {
    toast(error.message || "Could not start checkout.", "error");
    button.disabled = false;
    button.textContent = isWire ? "Show bank instructions" : "Continue to secure checkout";
  }
});

wireReportForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = wireReportForm.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const data = await invokeFunction("report-wire-transfer", {
        reference: wireDetails.dataset.reference,
        email: $("#donor-email").value.trim(),
        transfer_reference: $("#transfer-reference").value.trim(),
      });
    $("#wire-report-message").textContent = data.message;
    button.textContent = "Transfer submitted";
  } catch (error) {
    toast(error.message || "Could not submit transfer details.", "error");
    button.disabled = false;
  }
});

verifyAgain.addEventListener("click", () => {
  if (activeReference) verifyPayment(activeReference);
});

const query = new URLSearchParams(window.location.search);
const reference = query.get("reference") || query.get("trxref");
if (reference) verifyPayment(reference);
else loadWireAccounts();
