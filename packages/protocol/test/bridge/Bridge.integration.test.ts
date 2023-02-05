import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers as ethersLib } from "ethers";
import hre, { ethers } from "hardhat";
import {
    AddressManager,
    Bridge,
    SignalService,
    TestHeaderSync,
    TestBadReceiver,
} from "../../typechain";
import deployAddressManager from "../utils/addressManager";
import {
    deployBridge,
    processMessage,
    sendAndProcessMessage,
    sendMessage,
} from "../utils/bridge";
// import { randomBytes32 } from "../utils/bytes";
import { Message } from "../utils/message";
import { getDefaultL2Signer, getL2Provider } from "../utils/provider";
import { Block, getBlockHeader } from "../utils/rpc";
import { deploySignalService, getSignalProof } from "../utils/signal";

describe("integration:Bridge", function () {
    let owner: SignerWithAddress;
    let l2Provider: ethersLib.providers.JsonRpcProvider;
    let l2Signer: ethersLib.Signer;
    let srcChainId: number;
    let enabledDestChainId: number;
    let l2NonOwner: ethersLib.Signer;
    let l1SignalService: SignalService;
    let l2SignalService: SignalService;
    let l1Bridge: Bridge;
    let l2Bridge: Bridge;
    let m: Message;
    let l1HeaderSync: TestHeaderSync;
    let l2HeaderSync: TestHeaderSync;

    beforeEach(async () => {
        [owner] = await ethers.getSigners();

        const { chainId } = await ethers.provider.getNetwork();

        srcChainId = chainId;

        // seondary node to deploy L2 on
        l2Provider = getL2Provider();

        l2Signer = await getDefaultL2Signer();

        l2NonOwner = await l2Provider.getSigner();

        const l2Network = await l2Provider.getNetwork();

        enabledDestChainId = l2Network.chainId;

        const addressManager: AddressManager = await deployAddressManager(
            owner
        );

        const l2AddressManager: AddressManager = await deployAddressManager(
            l2Signer
        );

        ({ signalService: l1SignalService } = await deploySignalService(
            owner,
            addressManager,
            srcChainId
        ));

        ({ signalService: l2SignalService } = await deploySignalService(
            l2Signer,
            l2AddressManager,
            enabledDestChainId
        ));

        await addressManager.setAddress(
            `${enabledDestChainId}.signal_service`,
            l2SignalService.address
        );

        await l2AddressManager.setAddress(
            `${srcChainId}.signal_service`,
            l1SignalService.address
        );

        ({ bridge: l1Bridge } = await deployBridge(
            owner,
            addressManager,
            srcChainId
        ));

        ({ bridge: l2Bridge } = await deployBridge(
            l2Signer,
            l2AddressManager,
            enabledDestChainId
        ));

        await addressManager.setAddress(
            `${enabledDestChainId}.bridge`,
            l2Bridge.address
        );

        await l2AddressManager
            .connect(l2Signer)
            .setAddress(`${srcChainId}.bridge`, l1Bridge.address);

        l1HeaderSync = await (await ethers.getContractFactory("TestHeaderSync"))
            .connect(owner)
            .deploy();

        await addressManager
            .connect(owner)
            .setAddress(`${srcChainId}.taiko`, l1HeaderSync.address);

        l2HeaderSync = await (await ethers.getContractFactory("TestHeaderSync"))
            .connect(l2Signer)
            .deploy();

        await l2AddressManager
            .connect(l2Signer)
            .setAddress(`${enabledDestChainId}.taiko`, l2HeaderSync.address);

        m = {
            id: 1,
            sender: owner.address,
            srcChainId: srcChainId,
            destChainId: enabledDestChainId,
            owner: owner.address,
            to: owner.address,
            refundAddress: owner.address,
            depositValue: 1000,
            callValue: 1000,
            processingFee: 1000,
            gasLimit: 10000,
            data: ethers.constants.HashZero,
            memo: "",
        };
    });

    describe("processMessage()", function () {
        it("should throw if message.gasLimit == 0 & msg.sender is not message.owner", async function () {
            const m: Message = {
                id: 1,
                sender: await l2NonOwner.getAddress(),
                srcChainId: srcChainId,
                destChainId: enabledDestChainId,
                owner: owner.address,
                to: owner.address,
                refundAddress: owner.address,
                depositValue: 1000,
                callValue: 1000,
                processingFee: 1000,
                gasLimit: 0,
                data: ethers.constants.HashZero,
                memo: "",
            };

            await expect(
                l2Bridge.processMessage(m, ethers.constants.HashZero)
            ).to.be.revertedWith("B:forbidden");
        });

        it("should throw if message.destChainId is not equal to current block.chainId", async function () {
            const m: Message = {
                id: 1,
                sender: owner.address,
                srcChainId: srcChainId,
                destChainId: enabledDestChainId + 1,
                owner: owner.address,
                to: owner.address,
                refundAddress: owner.address,
                depositValue: 1000,
                callValue: 1000,
                processingFee: 1000,
                gasLimit: 10000,
                data: ethers.constants.HashZero,
                memo: "",
            };

            await expect(
                l2Bridge.processMessage(m, ethers.constants.HashZero)
            ).to.be.revertedWith("B:destChainId");
        });

        it("should throw if messageStatus of message is != NEW", async function () {
            const { message, signalProof } = await sendAndProcessMessage(
                hre.ethers.provider,
                l2HeaderSync,
                m,
                l1SignalService,
                l1Bridge,
                l2Bridge
            );

            // recalling this process should be prevented as it's status is no longer NEW
            await expect(
                l2Bridge.processMessage(message, signalProof)
            ).to.be.revertedWith("B:status");
        });

        it("should throw if message signalproof is not valid", async function () {
            const msgHash = await l1Bridge.hashMessage(m);
            const { block, blockHeader } = await getBlockHeader(
                hre.ethers.provider
            );

            await l2HeaderSync.setSyncedHeader(ethers.constants.HashZero);

            const signalProof = await getSignalProof(
                hre.ethers.provider,
                l1SignalService.address,
                await l1SignalService.getSignalSlot(l1Bridge.address, msgHash),
                block.number,
                blockHeader
            );

            await expect(
                l2Bridge.processMessage(m, signalProof)
            ).to.be.revertedWith("B:notReceived");
        });

        it("should throw if message has not been received", async function () {
            const { msgHash, message } = await sendMessage(l1Bridge, m);

            expect(msgHash).not.to.be.eq(ethers.constants.HashZero);

            const messageStatus = await l1Bridge.getMessageStatus(msgHash);

            expect(messageStatus).to.be.eq(0);

            const sender = l1Bridge.address;

            const { block, blockHeader } = await getBlockHeader(
                hre.ethers.provider
            );

            await l2HeaderSync.setSyncedHeader(ethers.constants.HashZero);

            const slot = await l1SignalService.getSignalSlot(sender, msgHash);

            // get storageValue for the key
            const storageValue = await ethers.provider.getStorageAt(
                l1SignalService.address,
                slot,
                block.number
            );
            // make sure it equals 1 so our proof will pass
            expect(storageValue).to.be.eq(
                "0x0000000000000000000000000000000000000000000000000000000000000001"
            );

            const signalProof = await getSignalProof(
                hre.ethers.provider,
                l1SignalService.address,
                slot,
                block.number,
                blockHeader
            );

            await expect(
                l2Bridge.processMessage(message, signalProof)
            ).to.be.revertedWith("B:notReceived");
        });

        it("processes a message when the signal has been verified from the sending chain", async () => {
            const { msgHash, message } = await sendMessage(l1Bridge, m);

            expect(msgHash).not.to.be.eq(ethers.constants.HashZero);

            const messageStatus = await l1Bridge.getMessageStatus(msgHash);

            expect(messageStatus).to.be.eq(0);
            let block: Block;
            expect(
                ({ block } = await processMessage(
                    l1SignalService,
                    l1Bridge,
                    l2Bridge,
                    msgHash,
                    hre.ethers.provider,
                    l2HeaderSync,
                    message
                ))
            ).to.emit(l2Bridge, "MessageStatusChanged");

            // get storageValue for the key
            const storageValue = await ethers.provider.getStorageAt(
                l1SignalService.address,
                await l1SignalService.getSignalSlot(l1Bridge.address, msgHash),
                block.number
            );
            // make sure it equals 1 so our proof will pass
            expect(storageValue).to.be.eq(
                "0x0000000000000000000000000000000000000000000000000000000000000001"
            );
        });
    });

    describe("isMessageSent()", function () {
        it("should return false, since no message was sent", async function () {
            const msgHash = await l1Bridge.hashMessage(m);

            expect(await l1Bridge.isMessageSent(msgHash)).to.be.eq(false);
        });

        it("should return true if message was sent properly", async function () {
            const { msgHash } = await sendMessage(l1Bridge, m);

            expect(msgHash).not.to.be.eq(ethers.constants.HashZero);

            expect(await l1Bridge.isMessageSent(msgHash)).to.be.eq(true);
        });
    });

    describe("isMessageReceived()", function () {
        it("should throw if signal is not a bridge message; proof is invalid since sender != bridge.", async function () {
            const msgHash = ethers.utils.hexlify(ethers.utils.randomBytes(32));

            const tx = await l1SignalService.connect(owner).sendSignal(msgHash);

            await tx.wait();

            const sender = owner.address;

            const slot = await l1SignalService.getSignalSlot(sender, msgHash);

            const { block, blockHeader } = await getBlockHeader(
                hre.ethers.provider
            );

            await l2HeaderSync.setSyncedHeader(block.hash);

            // get storageValue for the key
            const storageValue = await ethers.provider.getStorageAt(
                l1SignalService.address,
                slot,
                block.number
            );
            // make sure it equals 1 so we know sendSignal worked
            expect(storageValue).to.be.eq(
                "0x0000000000000000000000000000000000000000000000000000000000000001"
            );

            const signalProof = await getSignalProof(
                hre.ethers.provider,
                l1SignalService.address,
                slot,
                block.number,
                blockHeader
            );

            await expect(
                l2Bridge.isMessageReceived(msgHash, srcChainId, signalProof)
            ).to.be.reverted;
        });

        it("if message is valid and sent by the bridge it should return true", async function () {
            const { msgHash } = await sendMessage(l1Bridge, m);
            const slot = await l1SignalService.getSignalSlot(
                l1Bridge.address,
                msgHash
            );

            const { block, blockHeader } = await getBlockHeader(
                hre.ethers.provider
            );

            await l2HeaderSync.setSyncedHeader(block.hash);

            // get storageValue for the key
            const storageValue = await ethers.provider.getStorageAt(
                l1SignalService.address,
                slot,
                block.number
            );
            // make sure it equals 1 so we know sendMessage worked
            expect(storageValue).to.be.eq(
                "0x0000000000000000000000000000000000000000000000000000000000000001"
            );

            const signalProof = await getSignalProof(
                hre.ethers.provider,
                l1SignalService.address,
                slot,
                block.number,
                blockHeader
            );

            expect(
                await l2Bridge.isMessageReceived(
                    msgHash,
                    srcChainId,
                    signalProof
                )
            ).to.be.eq(true);
        });
    });

    describe("isMessageFailed()", function () {
        it("test", async function () {
            const testBadReceiver: TestBadReceiver = await (
                await ethers.getContractFactory("TestBadReceiver")
            )
                .connect(l2Signer)
                .deploy();

            await testBadReceiver.deployed();

            const m: Message = {
                id: 1,
                sender: await l2Signer.getAddress(),
                srcChainId: srcChainId,
                destChainId: enabledDestChainId,
                owner: await l2Signer.getAddress(),
                to: testBadReceiver.address,
                refundAddress: await l2Signer.getAddress(),
                depositValue: 1,
                callValue: 10,
                processingFee: 1,
                gasLimit: 300000,
                data: ethers.utils.hexlify(ethers.utils.randomBytes(32)),
                memo: "",
            };

            const { msgHash, message } = await sendMessage(l1Bridge, m);

            const messageStatus = await l2Bridge.getMessageStatus(msgHash);
            expect(messageStatus).to.be.eq(0);

            // messageStatus should be retriable (1)
            const { messageStatusChangedEvent } = await processMessage(
                l1SignalService,
                l1Bridge,
                l2Bridge,
                msgHash,
                hre.ethers.provider,
                l2HeaderSync,
                message
            );
            expect(messageStatusChangedEvent.args.msgHash).to.be.eq(msgHash);
            expect(messageStatusChangedEvent.args.status).to.be.eq(1);

            const tx = await l2Bridge
                .connect(l2Signer)
                .retryMessage(message, true);
            const receipt = await tx.wait();
            expect(receipt.status).to.be.eq(1);

            const messageStatus2 = await l2Bridge.getMessageStatus(msgHash);
            expect(messageStatus2).to.be.eq(3);

            const { block, blockHeader } = await getBlockHeader(
                hre.ethers.provider
            );

            await l2HeaderSync.setSyncedHeader(block.hash);

            const slot = await l1Bridge.getMessageStatusSlot(msgHash);

            const signalProof = await getSignalProof(
                hre.ethers.provider,
                l1Bridge.address,
                slot,
                block.number,
                blockHeader
            );

            expect(
                await l1Bridge.isMessageFailed(
                    msgHash,
                    enabledDestChainId,
                    signalProof
                )
            ).to.eq(true);
        });

        it.only("fliptest", async function () {
            // L2 -> L1 message
            const testBadReceiver: TestBadReceiver = await (
                await ethers.getContractFactory("TestBadReceiver")
            )
                .connect(owner)
                .deploy();
            await testBadReceiver.deployed();

            const m: Message = {
                id: 1,
                sender: owner.address,
                srcChainId: enabledDestChainId,
                destChainId: srcChainId,
                owner: owner.address,
                to: testBadReceiver.address,
                refundAddress: owner.address,
                depositValue: 1,
                callValue: 10,
                processingFee: 1,
                gasLimit: 300000,
                data: ethers.utils.hexlify(ethers.utils.randomBytes(32)),
                memo: "",
            };

            const { msgHash, message } = await sendMessage(l2Bridge, m);

            const messageStatus = await l1Bridge.getMessageStatus(msgHash);
            expect(messageStatus).to.be.eq(0);

            const { messageStatusChangedEvent } = await processMessage(
                l2SignalService,
                l2Bridge,
                l1Bridge,
                msgHash,
                l2Provider,
                l1HeaderSync,
                message
            );
            expect(messageStatusChangedEvent.args.msgHash).to.be.eq(msgHash);
            expect(messageStatusChangedEvent.args.status).to.be.eq(1);

            // blocked here, we can't do the test l1 to l2 because isMessageFailed()
            // needs eth_getProof on L2 to be called, but we can't do the test l2 to l1 either
            // since processMessage() needs eth_getProof on L2 to be called as well.
        });
    });

    /*
    describe("isSignalReceived()", function () {
        it("should throw if sender == address(0)", async function () {
            const signal = randomBytes32();
            const sender = ethers.constants.AddressZero;
            const signalProof = ethers.constants.HashZero;

            await expect(
                l2SignalService.isSignalReceived(
                    signal,
                    srcChainId,
                    sender,
                    signalProof
                )
            ).to.be.revertedWith("B:sender");
        });

        it("should throw if signal == HashZero", async function () {
            const signal = ethers.constants.HashZero;
            const sender = owner.address;
            const signalProof = ethers.constants.HashZero;

            await expect(
                l2SignalService.isSignalReceived(
                    signal,
                    srcChainId,
                    sender,
                    signalProof
                )
            ).to.be.revertedWith("B:signal");
        });

        it("should throw if calling from same layer", async function () {
            const signal = randomBytes32();

            const tx = await l1SignalService.connect(owner).sendSignal(signal);

            await tx.wait();

            const sender = owner.address;

            const key = await l1SignalService.getSignalSlot(sender, signal);

            const { block, blockHeader } = await getBlockHeader(
                hre.ethers.provider
            );

            await headerSync.setSyncedHeader(block.hash);

            // get storageValue for the key
            const storageValue = await ethers.provider.getStorageAt(
                l1SignalService.address,
                key,
                block.number
            );
            // make sure it equals 1 so our proof is valid
            expect(storageValue).to.be.eq(
                "0x0000000000000000000000000000000000000000000000000000000000000001"
            );

            const signalProof = await getSignalProof(
                hre.ethers.provider,
                l1SignalService.address,
                key,
                block.number,
                blockHeader
            );

            await expect(
                l1SignalService.isSignalReceived(
                    signal,
                    srcChainId,
                    sender,
                    signalProof
                )
            ).to.be.revertedWith("B:srcBridge");
        });

        it("should return true and pass", async function () {
            const signal = ethers.utils.hexlify(ethers.utils.randomBytes(32));

            const tx = await l1SignalService.connect(owner).sendSignal(signal);

            await tx.wait();

            const sender = owner.address;

            const key = await l1SignalService.getSignalSlot(sender, signal);

            const { block, blockHeader } = await getBlockHeader(
                hre.ethers.provider
            );

            await headerSync.setSyncedHeader(block.hash);

            // get storageValue for the key
            const storageValue = await ethers.provider.getStorageAt(
                l1SignalService.address,
                key,
                block.number
            );
            // make sure it equals 1 so our proof will pass
            expect(storageValue).to.be.eq(
                "0x0000000000000000000000000000000000000000000000000000000000000001"
            );

            const signalProof = await getSignalProof(
                hre.ethers.provider,
                l1SignalService.address,
                key,
                block.number,
                blockHeader
            );
            // proving functionality; l2Bridge can check if l1Bridge receives a signal
            // allowing for dapp cross layer communication
            expect(
                await l2SignalService.isSignalReceived(
                    signal,
                    srcChainId,
                    sender,
                    signalProof
                )
            ).to.be.eq(true);
        });
    });
*/
});
