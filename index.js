import express from 'express';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// REST API client for Smartwaiver
const smartwaiver = axios.create({
  baseURL: 'https://api.smartwaiver.com/v4',
  headers: {
    'sw-api-key': process.env.SMARTWAIVER_API_KEY
  }
});

// REST and GraphQL API client for Shopify
const shopify = axios.create({
  baseURL: `https://${process.env.SHOPIFY_SHOP_DOMAIN}/admin/api/2023-10`,
  headers: {
    'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_TOKEN,
    'Content-Type': 'application/json'
  }
});

// Function to update marketing consent using Shopify GraphQL
async function updateMarketingConsent(customerId, emailConsent = true, smsConsent = true) {
  // Construct the GraphQL mutations for email and SMS consent updates
  const mutation = `
    mutation customerMarketingConsentUpdate($emailInput: CustomerEmailMarketingConsentUpdateInput!, $smsInput: CustomerSmsMarketingConsentUpdateInput!) {
      customerEmailMarketingConsentUpdate(input: $emailInput) {
        customer {
          id
          emailMarketingConsent {
            acceptsMarketing
            consentUpdatedAt
            marketingOptInLevel
          }
        }
        userErrors {
          field
          message
        }
      }
      customerSmsMarketingConsentUpdate(input: $smsInput) {
        customer {
          id
          smsMarketingConsent {
            acceptsMarketing
            consentUpdatedAt
            marketingOptInLevel
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;
  
  // Shopify requires global IDs in the format: gid://shopify/Customer/123456789
  const customerGID = `gid://shopify/Customer/${customerId}`;
  const nowISO = new Date().toISOString();
  
  const variables = {
    emailInput: {
      customerId: customerGID,
      consent: {
        acceptsMarketing: emailConsent,
        marketingOptInLevel: emailConsent ? "explicit" : "none",
        consentUpdatedAt: nowISO
      }
    },
    smsInput: {
      customerId: customerGID,
      consent: {
        acceptsMarketing: smsConsent,
        marketingOptInLevel: smsConsent ? "explicit" : "none",
        consentUpdatedAt: nowISO
      }
    }
  };
  
  try {
    const gqlRes = await shopify.post('/graphql.json', {
      query: mutation,
      variables
    });
    console.log('GraphQL consent update result:', gqlRes.data);
  } catch (error) {
    console.error('GraphQL consent update error:', error.response?.data || error.message);
  }
}

app.get('/sync', async (req, res) => {
  try {
    // Fetch waivers signed in the last 5 minutes
    const fromDts = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const toDts = new Date().toISOString();

    const { data } = await smartwaiver.get('/waivers', {
      params: { fromDts, toDts }
    });
    const waivers = data.waivers || [];
    
    console.log(`🧾 Found ${waivers.length} waivers from the last 5 minutes`);

    for (const { waiverId } of waivers) {
      const waiverRes = await smartwaiver.get(`/waivers/${waiverId}`, {
        params: { pdf: 'false' }
      });
      const w = waiverRes.data.waiver || {};
      const p = w.participant || {};
      
      // Try top-level field first, then fallback
      const email = w.email || p.email;
      const firstName = w.firstName || p.firstName || 'Unknown';
      const lastName = w.lastName || p.lastName || 'Unknown';
      const phone = w.phone || p.phone;
      const dateOfBirth = w.dob || p.dateOfBirth;
      
      let finalEmail = email;
      if (!finalEmail) {
        finalEmail = `${waiverId}@noemail.smartwaiver.com`;
        console.log(`⚠️ No email provided for waiver ${waiverId}; using placeholder: ${finalEmail}`);
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
        const existing = await shopify.get(`/customers/search.json?query=email:${finalEmail}`);
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
              first_name: firstName,
              last_name: lastName,
              email: finalEmail,
              phone,
              tags: tags.join(', '),
              note: `Signed waiver on ${w.createdOn} (Waiver ID: ${waiverId})`,
              accepts_marketing: true
            }
          });
          customer = created.customer;
        }
        
        if (dateOfBirth && customer && customer.id) {
          await shopify.post('/metafields.json', {
            metafield: {
              namespace: 'custom',
              key: 'dob',
              value: dateOfBirth,
              type: 'date',
              owner_id: customer.id,
              owner_resource: 'customer'
            }
          });
        }
        
        console.log(`✅ Synced waiver for ${finalEmail}`);
        // Update marketing consent via GraphQL
        await updateMarketingConsent(customer.id, true, true);
      } catch (shopifyError) {
        console.error(`❌ Shopify error for ${finalEmail}:`, shopifyError.response?.data || shopifyError.message);
      }
    }
    
    res.status(200).send(`Synced ${waivers.length} waivers from the last 5 minutes.`);
  } catch (error) {
    console.error('❌ Sync failed:', error.message);
    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response body:', JSON.stringify(error.response.data, null, 2));
    }
    res.status(500).send('Error syncing waivers');
  }
});

app.get('/', (req, res) => {
  res.send('✅ Smartwaiver Sync App is running!');
});

app.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
