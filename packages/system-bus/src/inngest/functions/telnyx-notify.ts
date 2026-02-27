import {
  checkSMSEnabled,
  getCall,
  getTelnyxConfig,
  placeCall,
  sendSMS,
} from "../../lib/telnyx";
import { inngest } from "../client";

type NotificationRequest = {
  message: string;
  to?: string;
};

const callWasAnswered = (status: unknown): boolean => {
  if (!status || typeof status !== "object") return false;

  const data = (status as Record<string, unknown>).data;
  if (!data || typeof data !== "object") return false;

  const record = data as Record<string, unknown>;
  const raw =
    record.call_status ??
    record.status ??
    record.state;

  if (typeof raw !== "string") return false;

  const normalized = raw.toLowerCase();
  return (
    normalized.includes("answered") ||
    normalized.includes("active") ||
    normalized.includes("in_progress") ||
    normalized.includes("in-progress") ||
    normalized.includes("bridged")
  );
};

export const telnyxNotify = inngest.createFunction(
  { id: "telnyx-notify", name: "Telnyx Notify: Call then SMS fallback" },
  { event: "notification/call.requested" },
  async ({ event, step }) => {
    const { message, to } = event.data as NotificationRequest;

    const config = await step.run("load-config", () => getTelnyxConfig());
    const target = (to ?? config.joelPhoneNumber).trim();

    let callResult: { data?: { call_control_id?: string } } | null = null;
    let answered = false;
    let smsSent = false;
    let smsEnabled: boolean | null = null;

    try {
      callResult = await step.run("place-call", async () => {
        return await placeCall(target, config.fromNumber, config.connectionId, message);
      });

      await step.sleep("wait-for-answer", "30s");

      answered = await step.run("check-call-status", async () => {
        const callId = callResult?.data?.call_control_id;
        if (!callId) return false;

        const status = await getCall(callId);
        return callWasAnswered(status);
      });
    } catch (error) {
      console.warn("[telnyx-notify] call flow failed; falling back to SMS", error);
    }

    if (!answered) {
      try {
        smsEnabled = await step.run("check-sms-enabled", async () => {
          return await checkSMSEnabled(config.fromNumber);
        });
      } catch (error) {
        console.warn("[telnyx-notify] SMS capability check failed", error);
        smsEnabled = null;
      }

      smsSent = await step.run("send-sms", async () => {
        try {
          await sendSMS(target, config.fromNumber, message);
          return true;
        } catch (error) {
          console.warn("[telnyx-notify] SMS send failed", error);
          return false;
        }
      });
    }

    return {
      notified: answered || smsSent,
      call: {
        attempted: true,
        answered,
        call_control_id: callResult?.data?.call_control_id ?? null,
      },
      sms: {
        attempted: !answered,
        sent: smsSent,
        sms_enabled: smsEnabled,
      },
    };
  },
);
