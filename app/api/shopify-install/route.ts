import { NextResponse } from 'next/server'
import crypto from 'crypto'

const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID!
const SCOPES = 'read_orders,read_customers,read_fulfillments,read_products'
const REDIRECT_URI = 'https://respondro.vercel.app/api/shopify-callback'

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const shop = searchParams.get('shop')

  if (!shop) {
    return NextResponse.json({ error: 'Missing shop' }, { status: 400 })
  }

  const state = crypto.randomBytes(16).toString('hex')

  const authUrl = `https://${shop}/admin/oauth/authorize?` +
    `client_id=${SHOPIFY_CLIENT_ID}&` +
    `scope=${SCOPES}&` +
    `redirect_uri=${REDIRECT_URI}&` +
    `state=${state}`

  return NextResponse.redirect(authUrl)
}