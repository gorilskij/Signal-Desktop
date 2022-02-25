// Copyright 2022 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { isNumber } from 'lodash';

import { handleMessageSend } from '../../util/handleMessageSend';
import { getSendOptions } from '../../util/getSendOptions';
import {
  isDirectConversation,
  isGroupV2,
} from '../../util/whatTypeOfConversation';
import { SignalService as Proto } from '../../protobuf';
import {
  handleMultipleSendErrors,
  maybeExpandErrors,
} from './handleMultipleSendErrors';
import { ourProfileKeyService } from '../../services/ourProfileKey';

import type { ConversationModel } from '../../models/conversations';
import type {
  ConversationQueueJobBundle,
  ProfileKeyJobData,
} from '../conversationJobQueue';
import type { CallbackResultType } from '../../textsecure/Types.d';
import { getUntrustedConversationIds } from './getUntrustedConversationIds';
import { areAllErrorsUnregistered } from './areAllErrorsUnregistered';
import { isConversationAccepted } from '../../util/isConversationAccepted';
import { isConversationUnregistered } from '../../util/isConversationUnregistered';

// Note: because we don't have a recipient map, we will resend this message to folks that
//   got it on the first go-round, if some sends fail. This is okay, because a recipient
//   getting your profileKey again is just fine.
export async function sendProfileKey(
  conversation: ConversationModel,
  {
    isFinalAttempt,
    shouldContinue,
    timestamp,
    timeRemaining,
    log,
  }: ConversationQueueJobBundle,
  data: ProfileKeyJobData
): Promise<void> {
  if (!shouldContinue) {
    log.info('Ran out of time. Giving up on sending profile key');
    return;
  }

  if (!conversation.get('profileSharing')) {
    log.info('No longer sharing profile. Cancelling job.');
    return;
  }

  const profileKey = await ourProfileKeyService.get();
  if (!profileKey) {
    log.info('Unable to fetch profile. Cancelling job.');
    return;
  }

  log.info(
    `starting profile key share to ${conversation.idForLogging()} with timestamp ${timestamp}`
  );

  const { revision } = data;
  const sendOptions = await getSendOptions(conversation.attributes);
  const { ContentHint } = Proto.UnidentifiedSenderMessage.Message;
  const contentHint = ContentHint.RESENDABLE;
  const sendType = 'profileKeyUpdate';

  let sendPromise: Promise<CallbackResultType>;

  // Note: flags and the profileKey itself are all that matter in the proto.

  const untrustedConversationIds = getUntrustedConversationIds(
    conversation.getRecipients()
  );
  if (untrustedConversationIds.length) {
    window.reduxActions.conversations.conversationStoppedByMissingVerification({
      conversationId: conversation.id,
      untrustedConversationIds,
    });
    throw new Error(
      `Profile key send blocked because ${untrustedConversationIds.length} conversation(s) were untrusted. Failing this attempt.`
    );
  }

  if (isDirectConversation(conversation.attributes)) {
    if (!isConversationAccepted(conversation.attributes)) {
      log.info(
        `conversation ${conversation.idForLogging()} is not accepted; refusing to send`
      );
      return;
    }
    if (isConversationUnregistered(conversation.attributes)) {
      log.info(
        `conversation ${conversation.idForLogging()} is unregistered; refusing to send`
      );
      return;
    }
    if (conversation.isBlocked()) {
      log.info(
        `conversation ${conversation.idForLogging()} is blocked; refusing to send`
      );
      return;
    }

    const proto = await window.textsecure.messaging.getContentMessage({
      flags: Proto.DataMessage.Flags.PROFILE_KEY_UPDATE,
      profileKey,
      recipients: conversation.getRecipients(),
      timestamp,
    });
    sendPromise = window.textsecure.messaging.sendIndividualProto({
      contentHint,
      identifier: conversation.getSendTarget(),
      options: sendOptions,
      proto,
      timestamp,
    });
  } else {
    if (isGroupV2(conversation.attributes) && !isNumber(revision)) {
      log.error('No revision provided, but conversation is GroupV2');
    }

    const groupV2Info = conversation.getGroupV2Info();
    if (groupV2Info && isNumber(revision)) {
      groupV2Info.revision = revision;
    }

    sendPromise = window.Signal.Util.sendToGroup({
      contentHint,
      groupSendOptions: {
        flags: Proto.DataMessage.Flags.PROFILE_KEY_UPDATE,
        groupV1: conversation.getGroupV1Info(),
        groupV2: groupV2Info,
        profileKey,
        timestamp,
      },
      messageId: undefined,
      sendOptions,
      sendTarget: conversation.toSenderKeyTarget(),
      sendType,
    });
  }

  try {
    await handleMessageSend(sendPromise, {
      messageIds: [],
      sendType,
    });
  } catch (error: unknown) {
    if (areAllErrorsUnregistered(conversation.attributes, error)) {
      log.info(
        'Group send failures were all UnregisteredUserError, returning succcessfully.'
      );
      return;
    }

    await handleMultipleSendErrors({
      errors: maybeExpandErrors(error),
      isFinalAttempt,
      log,
      timeRemaining,
      toThrow: error,
    });
  }
}
