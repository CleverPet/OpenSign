import crypto from 'node:crypto';

/**
 * Cloud function: createPublicSigningDoc
 *
 * Given a templateId and signer info, creates a document from the template
 * and returns a guest signing URL. No auth required — used for public
 * signing links where anyone can sign.
 */
export async function getPublicTemplate(request) {
  const { templateId } = request.params;

  if (!templateId) {
    throw new Parse.Error(Parse.Error.VALIDATION_ERROR, 'templateId is required');
  }

  const templateQuery = new Parse.Query('contracts_Template');
  const template = await templateQuery.get(templateId, { useMasterKey: true });

  if (!template) {
    throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'Template not found');
  }

  return {
    name: template.get('Name') || '',
    description: template.get('Description') || '',
  };
}

export async function createPublicSigningDoc(request) {
  const { templateId, signerName, signerEmail } = request.params;

  if (!templateId || !signerName || !signerEmail) {
    throw new Parse.Error(
      Parse.Error.VALIDATION_ERROR,
      'templateId, signerName, and signerEmail are required'
    );
  }

  // Fetch the template
  const templateQuery = new Parse.Query('contracts_Template');
  templateQuery.include('ExtUserPtr');
  templateQuery.include('CreatedBy');
  const template = await templateQuery.get(templateId, { useMasterKey: true });

  if (!template) {
    throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'Template not found');
  }

  // Find or create a contact for this signer
  const contactQuery = new Parse.Query('contracts_Contactbook');
  contactQuery.equalTo('Email', signerEmail.toLowerCase());
  let contact = await contactQuery.first({ useMasterKey: true });

  if (!contact) {
    const Contact = Parse.Object.extend('contracts_Contactbook');
    contact = new Contact();
    contact.set('Name', signerName);
    contact.set('Email', signerEmail.toLowerCase());
    contact.set('Phone', '');
    contact.set('CreatedBy', template.get('CreatedBy'));
    await contact.save(null, { useMasterKey: true });
  }

  // Build placeholders with signer info
  const templatePlaceholders = template.get('Placeholders') || [];
  const placeholders = templatePlaceholders.map((p) => {
    if (p.Role !== 'prefill') {
      return {
        ...p,
        email: signerEmail.toLowerCase(),
        name: signerName,
        Id: crypto.randomUUID(),
        objectId: contact.id,
      };
    }
    return p;
  });

  // Create the document
  const Document = Parse.Object.extend('contracts_Document');
  const doc = new Document();

  const isoDate = new Date().toISOString();
  const extUserPtr = template.get('ExtUserPtr');
  const createdBy = template.get('CreatedBy');

  doc.set('Name', template.get('Name') || 'Untitled');
  doc.set('URL', template.get('URL'));
  doc.set('SignedUrl', template.get('SignedUrl'));
  doc.set('Description', template.get('Description') || '');
  doc.set('Note', template.get('Note') || '');
  doc.set('Placeholders', placeholders);
  doc.set('ExtUserPtr', extUserPtr);
  doc.set('CreatedBy', createdBy);
  doc.set('Signers', [{ __type: 'Pointer', className: 'contracts_Contactbook', objectId: contact.id }]);
  doc.set('SendinOrder', false);
  doc.set('IsEnableOTP', template.get('IsEnableOTP') || false);
  doc.set('TimeToCompleteDays', template.get('TimeToCompleteDays') || 15);
  doc.set('DocSentAt', { __type: 'Date', iso: isoDate });
  doc.set('SentToOthers', true);
  doc.set('TemplateId', { __type: 'Pointer', className: 'contracts_Template', objectId: templateId });

  if (template.get('SignatureType')) doc.set('SignatureType', template.get('SignatureType'));
  if (template.get('SenderName')) doc.set('SenderName', template.get('SenderName'));
  if (template.get('SenderMail')) doc.set('SenderMail', template.get('SenderMail'));
  if (template.get('RedirectUrl')) doc.set('RedirectUrl', template.get('RedirectUrl'));

  await doc.save(null, { useMasterKey: true });

  // Build the guest signing URL
  const sendMail = false;
  const encoded = Buffer.from(
    `${doc.id}/${signerEmail.toLowerCase()}/${contact.id}/${sendMail}`
  ).toString('base64');

  return {
    documentId: doc.id,
    signingUrl: `/login/${encoded}`,
  };
}
