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

  // Exchange temporary code for permanent access token
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

  // Save store and token to Supabase
  await supabase.from('stores').upsert({
    shopify_url: shop,
    shopify_token: access_token,
    plan: 'trial',
    created_at: new Date().toISOString(),
  }, {
    onConflict: 'shopify_url'
  })

  // Redirect to Respondro with shop connected
  return NextResponse.redirect(
    `https://respondro.vercel.app/respondro.html?shop=${shop}&connected=true`
  )
}