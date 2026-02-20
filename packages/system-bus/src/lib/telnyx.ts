import { execSync } from "node:child_process";

const TELNYX_API_BASE = "https://api.telnyx.com/v2";

type CallResponse = {
  data?: {
    call_control_id?: string;
    call_leg_id?: string;
    call_session_id?: string;
    call_status?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

type MessageResponse = {
  data?: {
    id?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

type PhoneNumbersResponse = {
  data?: Array<{
    messaging?: {
      messaging_profile_id?: string | null;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
};

const leaseSecret = (name: string, envKey: string): string => {
  try {
    const value = execSync(`secrets lease ${name}`, { encoding: "utf8" }).trim();
    if (value) return value;
  } catch {
    // Fallback to env var below
  }

  const fallback = process.env[envKey]?.trim();
  if (fallback) return fallback;

  throw new Error(`Missing secret: ${name} (or env ${envKey})`);
};

const getApiKey = (): string => leaseSecret("telnyx_api_key", "TELNYX_API_KEY");

const telnyxRequest = async <T>(path: string, init: RequestInit): Promise<T> => {
  const apiKey = getApiKey();

  const response = await fetch(`${TELNYX_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telnyx request failed (${response.status}) ${path}: ${body}`);
  }

  return await response.json() as T;
};

const escapeXml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

export const getTelnyxConfig = () => {
  const connectionId = leaseSecret("telnyx_connection_id", "TELNYX_CONNECTION_ID");
  const fromNumber = leaseSecret("telnyx_phone_number", "TELNYX_PHONE_NUMBER");
  const ovpId = leaseSecret("telnyx_ovp_id", "TELNYX_OVP_ID");

  let joelPhoneNumber = "";
  try {
    joelPhoneNumber = leaseSecret("joel_phone_number", "JOEL_PHONE_NUMBER");
  } catch {
    const envFallback = process.env.JOEL_PHONE_NUMBER?.trim();
    if (!envFallback) {
      throw new Error("Missing secret: joel_phone_number (or env JOEL_PHONE_NUMBER)");
    }
    joelPhoneNumber = envFallback;
  }

  return {
    connectionId,
    fromNumber,
    ovpId,
    joelPhoneNumber,
  };
};

export const placeCall = async (
  to: string,
  from: string,
  connectionId: string,
  message?: string,
): Promise<CallResponse> => {
  if (message && message.trim()) {
    const texml = `<Response><Say voice='alice'>${escapeXml(message)}</Say><Hangup/></Response>`;

    return await telnyxRequest<CallResponse>("/texml/calls", {
      method: "POST",
      body: JSON.stringify({
        to,
        from,
        connection_id: connectionId,
        texml,
      }),
    });
  }

  const { ovpId } = getTelnyxConfig();

  return await telnyxRequest<CallResponse>("/calls", {
    method: "POST",
    body: JSON.stringify({
      connection_id: connectionId,
      to,
      from,
      outbound_voice_profile_id: ovpId,
      answering_machine_detection: "detect",
      webhook_url: "",
    }),
  });
};

export const getCall = async (callControlId: string): Promise<CallResponse> => {
  return await telnyxRequest<CallResponse>(`/calls/${callControlId}`, {
    method: "GET",
  });
};

export const sendSMS = async (to: string, from: string, text: string): Promise<MessageResponse> => {
  return await telnyxRequest<MessageResponse>("/messages", {
    method: "POST",
    body: JSON.stringify({
      from,
      to,
      text,
      type: "SMS",
    }),
  });
};

export const checkSMSEnabled = async (phoneNumber: string): Promise<boolean> => {
  const encoded = encodeURIComponent(phoneNumber);
  const payload = await telnyxRequest<PhoneNumbersResponse>(
    `/phone_numbers?filter[phone_number]=${encoded}`,
    { method: "GET" },
  );

  const record = payload.data?.[0];
  return Boolean(record?.messaging?.messaging_profile_id);
};
