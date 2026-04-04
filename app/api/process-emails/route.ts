import { NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'

const claude = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
})

export async function POST(request: Request) {
  const { emails, storeConfig } = await request.json()

  const results = await Promise.allSettled(
    emails.map((email: any) => processEmail(email, storeConfig))
  )

  return NextResponse.json({ results })
}

async function processEmail(email: any, config: any) {
  const systemPrompt = `You are the customer service agent for ${config.storeName}.

## Store policies
${config.rulebook}

## Custom rules
${config.rules
  .filter((r: any) => r.on)
  .map((r: any) => `- When: ${r.condition}\n  Do: ${r.action}`)
  .join('\n')}

## Instructions
- Reply in the same language as the customer
- If this requires a refund over €100 or you are unsure, end your reply with [ESCALATE]`

  const response = await claude.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    system: systemPrompt,
    messages: [{
      role: 'user',
      content: `From: ${email.from}\nSubject: ${email.subject}\n\n${email.body}`
    }]
  })

  const text = response.content[0].type === 'text' ? response.content[0].text : ''

  return {
    emailId: email.id,
    reply: text.replace('[ESCALATE]', '').trim(),
    escalate: text.includes('[ESCALATE]'),
  }
}