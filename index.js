import express from 'express';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware to parse JSON bodies
app.use(express.json());

const smartwaiver = axios.create({
  baseURL: 'https://api.smartwaiver.com/v4',
  headers: {
    'sw-api-key': process.env.SMARTWAIVER_API_KEY
  }
});

const shopify = axios.create({
  baseURL: `https://${process.env.SHOPIFY_SHOP_DOMAIN}/admin/api/2023-10`,
  headers: {
    'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_TOKEN,
    'Content-Type': 'application/json'
  }
});

// POST route to receive webhook from Smartwaiver
app.post('/sync', async (req, res) => {
  const { unique_id } = req.body;

  if (!unique_id) {
    console.error('❌ No unique_id in webhook payload:', req.body);
    return res.status(400).send('Missing unique_id');
  }

  console.log('📩 Webhook received for waiver ID:', unique_id);

  try {
    const waiverRes = await smartwaiver.get(`/waivers/${unique_id}`);
    const w = waiverRes.data.waiver || {};
    const p = w.participant || {};
    const email = p.email;

    if (!email) {
      console.log(`⚠️ Skipped waiver ${unique_id} (no email)`);
      return res.status(200).send('No email — skipped');
    }

    const tags = ['Signed Waiver'];
    switch (w.templateId) {
      case 'qfyohqaysnfk4ybccqhyzk':
        tags.push('Action Sports Waiver');
        break;
      case 'rwaatviecns3lrzbavotxg':
        tags.push('Spectator Waiver');
        break;
      case '61xznzj5qj3dkb2rj68kbn':
        tags.push('Power Sports Waiver');
        break;
    }

    try {
      const existing = await shopify.get(`/customers/search.json?query=email:${email}`);
      let customer = existing.data.customers[0];

      if (customer) {
        await shopify.put(`/customers/${customer.id}.json`, {
          customer: {
            id: customer.id,
            tags: [...new Set([...customer.tags.split(', '), ...tags])].join(', '),
            note: `Signed waiver on ${w.createdOn} (Waiver ID: ${unique_id})`,
            accepts_marketing: true
          }
        });
      } else {
        const { data: created } = await shopify.post('/customers.json', {
          customer: {
            first_name: p.firstName,
            last_name: p.lastName,
            email,
            phone: p.phone,
            tags: tags.join(', '),
            note: `Signed waiver on ${w.createdOn} (Waiver ID: ${unique_id})`,
            accepts_marketing: true
          }
        });
        customer = created.customer;
      }

      if (p.dateOfBirth) {
        await shopify.post('/metafields.json', {
          metafield: {
            namespace: 'custom',
            key: 'dob',
            value: p.dateOfBirth,
            type: 'date',
            owner_id: customer.id,
            owner_resource: 'customer'
          }
        });
      }

      console.log(`✅ Successfully synced waiver for ${email}`);
      res.status(200).send('Success');
    } catch (shopifyError) {
      console.error(`❌ Shopify error for ${email}:`, shopifyError.response?.data || shopifyError.message);
      res.status(500).send('Shopify error');
    }
  } catch (error) {
    console.error('❌ Failed to fetch waiver:', error.message);
    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response body:', JSON.stringify(error.response.data, null, 2));
    }
    res.status(500).send('Error syncing waiver');
  }
});

// Home route for testing
app.get('/', (req, res) => {
  res.send('✅ Smartwaiver Sync App is running!');
});

app.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
