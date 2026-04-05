import { NextResponse } from 'next/server'

const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID!
const SCOPES = 'read_orders,read_customers,read_fulfillments,read_products'
const REDIRECT_URI = 'https://respondro.vercel.app/api/shopify-callback'

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const shop = searchParams.get('shop')

  if (!shop) {
    return NextResponse.json({ error: 'Missing shop' }, { status: 400 })
  }

  // Extract just the store handle e.g. "xhale" from "xhale.myshopify.com"
  const storeHandle = shop.replace('.myshopify.com', '')

  // Use admin.shopify.com format — bypasses storefront password
  const authUrl = `https://admin.shopify.com/store/${storeHandle}/oauth/authorize?` +
    `client_id=${SHOPIFY_CLIENT_ID}&` +
    `scope=${SCOPES}&` +
    `redirect_uri=${REDIRECT_URI}`

  return NextResponse.redirect(authUrl)
}