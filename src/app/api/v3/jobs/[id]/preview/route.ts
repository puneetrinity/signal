import {NextRequest,NextResponse} from 'next/server';
import {z} from 'zod';
import {verifyServiceJWT} from '@/lib/auth/service-jwt';
import {requireScope} from '@/lib/auth/service-scopes';
import {GovernedRepository,admitGovernedPreview,governedAdmissionRefusal} from '@/lib/sourcing/governed-authority';
import {governedEnabled,governedPreviewSchema} from '@/lib/sourcing/governed-contracts';
import {getSourcingQueue} from '@/lib/sourcing/queue/producer';

/** This endpoint holds no provider credentials and performs no provider I/O. */
export async function POST(request:NextRequest,{params}:{params:Promise<{id:string}>}) {
  const auth=await verifyServiceJWT(request);if(!auth.authorized)return auth.response;
  const scope=requireScope(auth.context,'jobs:preview');if(!scope.authorized)return scope.response;
  try {
    if(!governedEnabled())return NextResponse.json({error:'GOVERNED_DISABLED'},{status:409});
    const {id:jobId}=await params;
    if(!/^vanta:jobs:[1-9][0-9]*$/.test(jobId))return NextResponse.json({error:'GOVERNED_INVALID_COMMAND'},{status:400});
    // Count bytes while streaming, not after allocating an unbounded body.
    if(!request.body)return NextResponse.json({error:'GOVERNED_INVALID_COMMAND'},{status:400});
    const reader=request.body.getReader();const chunks:Uint8Array[]=[];let bytes=0;
    try {
      while(true){const {done,value}=await reader.read();if(done)break;
        bytes+=value.byteLength;if(bytes>131072)return NextResponse.json({error:'GOVERNED_BODY_TOO_LARGE'},{status:413});chunks.push(value);}
    }finally{await reader.cancel().catch(()=>undefined);reader.releaseLock();}
    const body=governedPreviewSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    const result=await admitGovernedPreview(new GovernedRepository(),auth.context.tenantId,jobId,body) as {state:string}|null;
    if(!result)throw Error('GOVERNED_UNAVAILABLE');
    if(result.state==='pending') {
      // Replaying the POST repairs a lost queue insertion with the same ID.
      // A started/unknown SQL receipt can never start another provider call.
      await getSourcingQueue().add('preview',{kind:'preview',tenantId:auth.context.tenantId,previewId:body.previewId},
        {jobId:`preview-${body.previewId}`,attempts:3,backoff:{type:'exponential',delay:5000},removeOnComplete:true,removeOnFail:true});
    }
    return NextResponse.json(result,{status:result.state==='pending'?202:200});
  }catch(error){
    if(error instanceof z.ZodError || error instanceof SyntaxError)return NextResponse.json({error:'GOVERNED_INVALID_COMMAND'},{status:400});
    const refusal=governedAdmissionRefusal(error);
    if(refusal)return NextResponse.json({error:refusal.error},{status:refusal.status});
    // Database details, JSON bodies, tokens and provider information stay out
    // of error responses. Replays may safely recover the same durable identity.
    return NextResponse.json({error:'GOVERNED_PREVIEW_UNAVAILABLE'},{status:503});
  }
}
