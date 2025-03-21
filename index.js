import express from 'express';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;

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

app.get('/sync', async (req, res) => {
  try {
    // Step 1: Pull from Smartwaiver webhook queue
    const queueRes = await smartwaiver.get('/webhooks/queue');
    const message = queueRes.data.message;

    if (!message || !message.unique_id) {
      console.log('📭 No new messages in queue');
      return res.status(200).send('No new messages in queue');
    }

    const waiverId = message.unique_id;
    console.log('📩 Pulled webhook from queue for waiver:', waiverId);

    // Step 2: Fetch full waiver data
    const waiverRes = await smartwaiver.get(`/waivers/${waiverId}`);
    const w = waiverRes.data.waiver || {};
    const p = w.participant || {};
    const email = p.email;

    if (!email) {
      console.log(`⚠️ Skipped waiver ${waiverId} (no email)`);
      return res.status(200).send('No email — skipped');
    }

    // Step 3: Determine tags
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

    // Step 4: Create or update Shopify customer
    try {
      const existing = await shopify.get(`/customers/search.json?query=email:${email}`);
      let customer = existing.data.customers[0];

      if (customer) {
        await shopify.put(`/customers/${customer.id}.json`, {
          customer: {
            id: customer.id,
            tags: [...new Set([...customer.tags.split(', '), ...tags])].join(', '),
            note: `Signed waiver on ${w.createdOn} (Waiver ID: ${waiverId})`,
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
            note: `Signed waiver on ${w.createdOn} (Waiver ID: ${waiverId})`,
            accepts_marketing: true
          }
        });
        customer = created.customer;
      }

      // Step 5: Add DOB metafield
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
      res.status(200).send(`Synced waiver for ${email}`);
    } catch (shopifyError) {
      console.error(`❌ Shopify error for ${email}:`, shopifyError.response?.data || shopifyError.message);
      res.status(500).send('Shopify error');
    }

  } catch (error) {
    console.error('❌ Sync failed:', error.message);
    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response body:', JSON.stringify(error.response.data, null, 2));
    }
    res.status(500).send('Error syncing waiver');
  }
});

// Home route
app.get('/', (req, res) => {
  res.send('✅ Smartwaiver Sync App is running (via webhook queue)');
});

app.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
