import type { IngestMessage } from '@edgewatch/shared';
import { processMessage, type Env } from './process';

export type { Env };

export default {
  async queue(batch: MessageBatch<IngestMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        await processMessage(message.body, env);
        message.ack();
      } catch (e) {
        console.error('edgewatch: failed to process message', message.id, e);
        message.retry({ delaySeconds: Math.min(60, 2 ** message.attempts) });
      }
    }
  },
} satisfies ExportedHandler<Env, IngestMessage>;
