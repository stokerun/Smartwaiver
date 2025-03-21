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
  const fromDts = Math.floor((Date.now() - 5 * 60 * 1000) / 1000); // last 5 minutes

  try {
    const { data } = await smartwaiver.get(`/waivers?fromDts=${fromDts}`);
    const waivers = data.waivers || [];

    console.log(`🧾 Found ${waivers.length} new waivers`);

    for (const { waiverId } of waivers) {
      const waiverRes = await smartwaiver.get(`/waivers/${waiverId}`);
      const w = waiverRes.data.waiver || {};
      const p = w.participant || {};
      const email = p.email;

      if (!email) continue;

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

        console.log(`✅ Synced waiver for ${email}`);
      } catch (err) {
        console.error(`❌ Shopify error for ${email}:`, err.response?.data || err.message);
      }
    }

    res.status(200).send(`Synced ${waivers.length} waivers.`);
  } catch (error) {
    console.error('❌ Sync failed:', error.message);
    res.status(500).send('Error syncing waivers');
  }
});

app.get('/', (req, res) => {
  res.send('✅ Smartwaiver Sync App is running!');
});

app.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
