import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID!
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET!

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_KEY!
)

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const shop = searchParams.get('shop')
  const code = searchParams.get('code')

  if (!shop || !code) {
    return NextResponse.json({ error: 'Missing params' }, { status: 400 })
  }

  // Exchange the temporary code for a permanent access token
  const tokenResponse = await fetch(
    `https://${shop}/admin/oauth/access_token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: SHOPIFY_CLIENT_ID,
        client_secret: SHOPIFY_CLIENT_SECRET,
        code,
      }),
    }
  )

  const { access_token } = await tokenResponse.json()

  // Save the shop and token to Supabase
  await supabase.from('stores').upsert({
    shopify_url: shop,
    shopify_token: access_token,
    plan: 'trial',
    created_at: new Date().toISOString(),
  }, {
    onConflict: 'shopify_url'
  })

  // Auto-sync Shopify store policies
  if (access_token) {
    try {
      const shopRes = await fetch(
        `https://${shop}/admin/api/2024-01/shop.json`,
        { headers: { 'X-Shopify-Access-Token': access_token } }
      )
      const shopData = await shopRes.json()

      const policiesRes = await fetch(
        `https://${shop}/admin/api/2024-01/policies.json`,
        { headers: { 'X-Shopify-Access-Token': access_token } }
      )
      const policies = await policiesRes.json()

      const rulebook = `STORE: ${shopData.shop?.name}
CURRENCY: ${shopData.shop?.currency}
COUNTRY: ${shopData.shop?.country_name}
TIMEZONE: ${shopData.shop?.timezone}

POLICIES FROM SHOPIFY:
${policies.policies?.map((p: any) => `${p.title}: ${p.body?.replace(/<[^>]*>/g, '').slice(0, 300)}`).join('\n\n') || 'No policies found'}

SHIPPING: Check Shopify for current shipping rates.
ALWAYS ESCALATE: Refunds over €100, legal threats, chargebacks.`

      await supabase.from('stores').update({
        rulebook: rulebook,
      }).eq('shopify_url', shop)
    } catch (e) {
      // Policies fetch failed — not critical
    }
  }

  // Redirect to Respondro dashboard
  return NextResponse.redirect(
    `https://respondro.vercel.app/respondro.html?shop=${shop}&connected=true`
  )
}