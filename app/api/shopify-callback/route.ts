import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID!
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET!
const SUPABASE_URL = process.env.SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_KEY!

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const shop = searchParams.get('shop')
  const code = searchParams.get('code')

  if (!shop || !code) {
    return NextResponse.json({ error: 'Missing shop or code' }, { status: 400 })
  }

  // Exchange code for permanent token
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

  const tokenData = await tokenResponse.json()
  const access_token = tokenData.access_token

  if (!access_token) {
    return NextResponse.json({ 
      error: 'No token received', 
      details: tokenData 
    }, { status: 400 })
  }

  // Save to Supabase
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
  
  const { error } = await supabase.from('stores').insert({
    shopify_url: shop,
    shopify_token: access_token,
    store_name: shop,
    plan: 'trial',
  })

  if (error) {
    return NextResponse.json({ 
      error: 'Database save failed', 
      details: error 
    }, { status: 500 })
  }

  return NextResponse.redirect(
    `https://respondro.vercel.app/respondro.html?shop=${shop}&connected=true`
  )
}