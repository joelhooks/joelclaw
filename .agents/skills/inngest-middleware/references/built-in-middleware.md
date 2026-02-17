# Built-in Inngest Middleware

Inngest provides several built-in middleware packages for common use cases. These middleware handle encryption, error tracking, and other cross-cutting concerns with minimal configuration.

## Encryption Middleware

Automatically encrypt and decrypt sensitive data in events and function outputs:

```typescript
import { encryptionMiddleware } from "inngest";

const inngest = new Inngest({
  id: "my-app",
  middleware: [
    encryptionMiddleware({
      key: process.env.ENCRYPTION_KEY, // 32-byte encryption key
      // Optional: specify which fields to encrypt
      eventDataPaths: ["user.ssn", "payment.cardNumber"],
      outputPaths: ["result.sensitive"]
    })
  ]
});

// Usage - sensitive data is automatically encrypted
inngest.createFunction(
  { id: "process-sensitive-data" },
  { event: "user/created" },
  async ({ event }) => {
    // event.data.user.ssn is automatically decrypted here
    console.log(event.data.user.ssn); // Plaintext value

    return {
      userId: event.data.userId,
      result: {
        sensitive: "This will be encrypted in logs" // Auto-encrypted
      }
    };
  }
);
```

### Custom Encryption Implementation

For more control, create custom encryption middleware:

```typescript
import { InngestMiddleware } from "inngest";
import { createCipher, createDecipher, randomBytes } from "crypto";

const createCustomEncryptionMiddleware = (encryptionKey: string) => {
  const algorithm = "aes-256-gcm";

  const encrypt = (text: string): string => {
    const iv = randomBytes(16);
    const cipher = createCipher(algorithm, encryptionKey);
    cipher.setAAD(Buffer.from("inngest-data"));

    let encrypted = cipher.update(text, "utf8", "hex");
    encrypted += cipher.final("hex");

    const authTag = cipher.getAuthTag();
    return iv.toString("hex") + ":" + authTag.toString("hex") + ":" + encrypted;
  };

  const decrypt = (encrypted: string): string => {
    const [ivHex, authTagHex, encryptedText] = encrypted.split(":");
    const iv = Buffer.from(ivHex, "hex");
    const authTag = Buffer.from(authTagHex, "hex");

    const decipher = createDecipher(algorithm, encryptionKey);
    decipher.setAAD(Buffer.from("inngest-data"));
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encryptedText, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  };

  return new InngestMiddleware({
    name: "Custom Encryption",
    init() {
      return {
        onFunctionRun({ ctx }) {
          return {
            transformInput() {
              // Decrypt sensitive event data
              if (ctx.event.data.encrypted_fields) {
                const decryptedFields = {};
                for (const [key, encryptedValue] of Object.entries(
                  ctx.event.data.encrypted_fields
                )) {
                  decryptedFields[key] = decrypt(encryptedValue as string);
                }

                return {
                  ctx: {
                    event: {
                      ...ctx.event,
                      data: {
                        ...ctx.event.data,
                        ...decryptedFields,
                        encrypted_fields: undefined // Remove encrypted versions
                      }
                    }
                  }
                };
              }
              return {};
            },

            transformOutput({ result }) {
              // Encrypt sensitive output fields
              if (result.data?.sensitiveData) {
                const encrypted = encrypt(
                  JSON.stringify(result.data.sensitiveData)
                );
                return {
                  result: {
                    ...result,
                    data: {
                      ...result.data,
                      encrypted_output: encrypted,
                      sensitiveData: undefined // Remove plaintext
                    }
                  }
                };
              }
              return { result };
            }
          };
        }
      };
    }
  });
};

// Usage
const inngest = new Inngest({
  id: "my-app",
  middleware: [createCustomEncryptionMiddleware(process.env.ENCRYPTION_KEY)]
});
```

## Sentry Error Tracking

Automatically capture and track errors in your Inngest functions:

```typescript
import { sentryMiddleware } from "inngest";

const inngest = new Inngest({
  id: "my-app",
  middleware: [
    sentryMiddleware({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.NODE_ENV,
      // Optional: custom error filtering
      beforeSend(event) {
        // Filter out non-critical errors
        if (event.exception?.values?.[0]?.type === "ValidationError") {
          return null; // Don't send to Sentry
        }
        return event;
      },
      // Optional: custom tags and context
      tags: {
        service: "inngest-functions",
        version: process.env.APP_VERSION
      }
    })
  ]
});
```

### Custom Sentry Integration

For more control over error tracking:

```typescript
import { InngestMiddleware } from "inngest";
import * as Sentry from "@sentry/node";

const createCustomSentryMiddleware = (sentryConfig: {
  dsn: string;
  environment: string;
  sampleRate?: number;
}) => {
  return new InngestMiddleware({
    name: "Custom Sentry Error Tracking",
    init() {
      Sentry.init({
        dsn: sentryConfig.dsn,
        environment: sentryConfig.environment,
        tracesSampleRate: sentryConfig.sampleRate || 0.1,
        integrations: [
          // Add custom integrations
          new Sentry.Integrations.Http({ tracing: true })
        ]
      });

      return {
        onFunctionRun({ ctx, fn }) {
          return {
            beforeExecution() {
              // Set Sentry context for this function execution
              Sentry.configureScope((scope) => {
                scope.setTag("inngest.function", fn.id);
                scope.setTag("inngest.event", ctx.event.name);
                scope.setTag("inngest.runId", ctx.runId);
                scope.setTag("inngest.attempt", ctx.attempt.toString());

                scope.setContext("inngest", {
                  functionId: fn.id,
                  eventName: ctx.event.name,
                  eventData: ctx.event.data,
                  runId: ctx.runId,
                  attempt: ctx.attempt,
                  timestamp: ctx.event.ts
                });

                scope.setUser({
                  id: ctx.event.user?.id || "unknown",
                  email: ctx.event.user?.email
                });
              });

              // Start Sentry transaction
              const transaction = Sentry.startTransaction({
                name: `inngest.function.${fn.id}`,
                op: "function.execution"
              });

              Sentry.getCurrentHub().configureScope((scope) =>
                scope.setSpan(transaction)
              );
            },

            afterExecution() {
              // Finish Sentry transaction
              const transaction = Sentry.getCurrentHub()
                .getScope()
                ?.getTransaction();
              transaction?.finish();
            },

            transformOutput({ result, step }) {
              // Capture errors with rich context
              if (result.error) {
                Sentry.withScope((scope) => {
                  if (step) {
                    scope.setTag("inngest.step", step.displayName);
                    scope.setContext("step", {
                      id: step.id,
                      name: step.displayName,
                      attempt: step.attempt
                    });
                  }

                  scope.setLevel("error");
                  scope.setContext("errorDetails", {
                    stepOutput: result.data,
                    errorMessage: result.error.message,
                    errorStack: result.error.stack
                  });

                  Sentry.captureException(result.error);
                });
              }

              // Capture warnings for non-fatal issues
              if (result.data?.warnings?.length > 0) {
                result.data.warnings.forEach((warning) => {
                  Sentry.addBreadcrumb({
                    message: warning,
                    level: "warning",
                    category: "inngest.warning"
                  });
                });
              }

              return { result };
            }
          };
        },

        onSendEvent() {
          return {
            transformInput({ payloads }) {
              // Track event sending
              Sentry.addBreadcrumb({
                message: `Sending ${payloads.length} events`,
                level: "info",
                category: "inngest.send_event",
                data: {
                  eventCount: payloads.length,
                  eventNames: payloads.map((p) => p.name)
                }
              });

              return { payloads };
            }
          };
        }
      };
    }
  });
};

// Usage
const inngest = new Inngest({
  id: "my-app",
  middleware: [
    createCustomSentryMiddleware({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.NODE_ENV,
      sampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0
    })
  ]
});
```

## Custom Error Tracking

If you don't use Sentry, create custom error tracking:

```typescript
const createErrorTrackingMiddleware = (config: {
  apiKey: string;
  endpoint: string;
  enableInDevelopment?: boolean;
}) => {
  const shouldTrack =
    config.enableInDevelopment || process.env.NODE_ENV === "production";

  const reportError = async (error: Error, context: any) => {
    if (!shouldTrack) return;

    try {
      await fetch(config.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          error: {
            message: error.message,
            stack: error.stack,
            name: error.name
          },
          context,
          timestamp: new Date().toISOString()
        })
      });
    } catch (reportingError) {
      console.error("Failed to report error:", reportingError);
    }
  };

  return new InngestMiddleware({
    name: "Custom Error Tracking",
    init() {
      return {
        onFunctionRun({ ctx, fn }) {
          return {
            transformOutput({ result, step }) {
              if (result.error) {
                reportError(result.error, {
                  function: fn.id,
                  event: ctx.event.name,
                  runId: ctx.runId,
                  attempt: ctx.attempt,
                  step: step?.displayName,
                  eventData: ctx.event.data
                });
              }

              return { result };
            }
          };
        }
      };
    }
  });
};
```

## Combining Built-in Middleware

Use multiple built-in middleware together:

```typescript
import {
  encryptionMiddleware,
  sentryMiddleware,
  dependencyInjectionMiddleware
} from "inngest";

const inngest = new Inngest({
  id: "my-app",
  middleware: [
    // Order matters - dependencies first
    dependencyInjectionMiddleware({
      db: new PrismaClient(),
      redis: createRedisClient()
    }),

    // Then encryption for data protection
    encryptionMiddleware({
      key: process.env.ENCRYPTION_KEY,
      eventDataPaths: ["user.ssn", "payment.details"]
    }),

    // Finally error tracking
    sentryMiddleware({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.NODE_ENV
    })
  ]
});
```

## Best Practices

### Middleware Ordering

1. **Dependencies first** - Inject services other middleware might need
2. **Data transformation** - Encryption, validation, enrichment
3. **Observability** - Logging, metrics, error tracking
4. **Business logic** - Custom middleware for specific use cases

### Error Handling

- Always wrap error tracking in try-catch blocks
- Don't let middleware errors crash your functions
- Log middleware failures for debugging
- Provide fallbacks when external services are unavailable

### Performance Considerations

- Built-in middleware is optimized for common use cases
- Custom middleware should be lightweight and fast
- Consider the overhead of external API calls in middleware
- Use caching and connection pooling appropriately
