import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

// 🛠️ THE FIX: Trick the server into thinking browser features exist
if (typeof global !== 'undefined') {
  if (!global.DOMMatrix) global.DOMMatrix = class DOMMatrix {} as any;
  if (!global.Path2D) global.Path2D = class Path2D {} as any;
}

export async function POST(request: Request) {
  try {
    const pdf = require('pdf-parse');

    const formData = await request.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return NextResponse.json({ error: 'No file uploaded' }, { status: 400 });
    }

    // Convert the uploaded file into a format Node.js can read
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    
    let extractedText = '';

    // Route logic based on file type
    if (file.name.toLowerCase().endsWith('.pdf')) {
      const data = await pdf(buffer);
      extractedText = data.text;
    } else {
      // Fallback for standard .txt files
      extractedText = buffer.toString('utf-8');
    }

    // Send the extracted text back to the frontend
    return NextResponse.json({ text: extractedText });
    
  } catch (error: any) {
    console.error('Error parsing document:', error);
    // Let's also send the exact error message back just in case!
    return NextResponse.json({ error: error.message || 'Failed to parse document' }, { status: 500 });
  }
}