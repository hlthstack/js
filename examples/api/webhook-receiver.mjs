// Webhook receiver. Express is the only dependency of the plain-API examples:
//   npm install express
//   HLTHSTACK_WEBHOOK_SECRET=... node examples/api/webhook-receiver.mjs
import express from 'express';
import { verifyWebhook } from './webhook-verify.mjs';

const SECRET = process.env.HLTHSTACK_WEBHOOK_SECRET; // different for staging and production
const app = express();
app.use(express.json());

app.post('/hlthstack/webhooks', (req, res) => {
  try {
    verifyWebhook(req.get('Signature'), req.body, SECRET);
  } catch {
    return res.sendStatus(401);
  }
  res.sendStatus(200); // acknowledge fast (hlthstack times out after 30 s)...
  setImmediate(() => handle(req.body)); // ...and process asynchronously
});

function handle(event) {
  // Appointment and pharmacy events share this URL: appointment payloads have
  // appointment_id, pharmacy payloads have order_id. Bodies are full snapshots and may
  // arrive out of order; reconcile with the GET endpoints.
  console.log(event.type, event.appointment_id ?? event.order_id ?? event.request_id, event.status);
}

app.listen(process.env.PORT ?? 3000);
