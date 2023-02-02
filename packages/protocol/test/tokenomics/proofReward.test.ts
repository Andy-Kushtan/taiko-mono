import { expect } from "chai";
import { SimpleChannel } from "channel-ts";
import { ethers } from "ethers";
import { TaikoL1 } from "../../typechain";
import { TestTkoToken } from "../../typechain/TestTkoToken";
import { pickRandomElement } from "../utils/array";
import blockListener from "../utils/blockListener";
import Proposer from "../utils/proposer";
import Prover from "../utils/prover";
import { createAndSeedWallets } from "../utils/seed";
import { commitProposeProveAndVerify } from "../utils/verify";
import { initTokenomicsFixture } from "./utils";

describe("tokenomics: proofReward", function () {
    let taikoL1: TaikoL1;
    let l2Provider: ethers.providers.JsonRpcProvider;
    let l1Signer: any;
    let proposerSigner: any;
    let proverSigner: any;
    let genesisHeight: number;
    let tkoTokenL1: TestTkoToken;
    let interval: any;
    let chan: SimpleChannel<number>;

    beforeEach(async () => {
        ({
            taikoL1,
            l2Provider,
            l1Signer,
            proposerSigner,
            proverSigner,
            genesisHeight,
            tkoTokenL1,
            interval,
        } = await initTokenomicsFixture());
        chan = new SimpleChannel<number>();
    });

    afterEach(() => {
        clearInterval(interval);
        l2Provider.off("block");
        chan.close();
    });

    it(`proofReward is 1 wei if the prover does not hold any tkoTokens on L1`, async function () {
        const { maxNumBlocks, commitConfirmations } = await taikoL1.getConfig();

        const proposer = new Proposer(
            taikoL1.connect(proposerSigner),
            l2Provider,
            commitConfirmations.toNumber(),
            maxNumBlocks.toNumber(),
            0,
            proposerSigner
        );

        const prover = new Prover(taikoL1, l2Provider, proverSigner);
        let proposed: boolean = false;
        l2Provider.on("block", function (blockNumber: number) {
            if (proposed) {
                chan.close();
                l2Provider.off("block");
                return;
            }
            proposed = true;

            chan.send(blockNumber);
        });

        /* eslint-disable-next-line */
        for await (const blockNumber of chan) {
            const proverTkoBalanceBeforeVerification =
                await tkoTokenL1.balanceOf(await prover.getSigner().address);

            await commitProposeProveAndVerify(
                taikoL1,
                l2Provider,
                blockNumber,
                proposer,
                tkoTokenL1,
                prover
            );

            const proverTkoBalanceAfterVerification =
                await tkoTokenL1.balanceOf(await prover.getSigner().address);

            // prover should have given 1 TKO token, since they
            // held no TKO balance.
            expect(proverTkoBalanceAfterVerification.sub(1)).to.be.eq(
                proverTkoBalanceBeforeVerification
            );
        }
    });

    it(`single prover, single proposer.
    propose blocks, wait til maxNumBlocks is filled.
    proverReward should decline should increase as blocks are proved then verified.
    the provers TKO balance should increase as the blocks are verified and
    they receive the proofReward.
    the proposer should receive a refund on his deposit because he holds a tkoBalance > 0 at time of verification.`, async function () {
        const { maxNumBlocks, commitConfirmations } = await taikoL1.getConfig();

        const proposer = new Proposer(
            taikoL1.connect(proposerSigner),
            l2Provider,
            commitConfirmations.toNumber(),
            maxNumBlocks.toNumber(),
            0,
            proposerSigner
        );

        const prover = new Prover(taikoL1, l2Provider, proverSigner);

        // prover needs TKO or their reward will be cut down to 1 wei.
        await (
            await tkoTokenL1
                .connect(l1Signer)
                .mintAnyone(
                    await proverSigner.getAddress(),
                    ethers.utils.parseEther("100")
                )
        ).wait(1);

        l2Provider.on(
            "block",
            blockListener(
                chan,
                genesisHeight,
                l2Provider,
                maxNumBlocks.toNumber()
            )
        );

        /* eslint-disable-next-line */
        for await (const blockNumber of chan) {
            const proverTkoBalanceBeforeVerification =
                await tkoTokenL1.balanceOf(await prover.getSigner().address);

            await commitProposeProveAndVerify(
                taikoL1,
                l2Provider,
                blockNumber,
                proposer,
                tkoTokenL1,
                prover
            );

            const proverTkoBalanceAfterVerification =
                await tkoTokenL1.balanceOf(await prover.getSigner().address);

            expect(
                proverTkoBalanceAfterVerification.gt(
                    proverTkoBalanceBeforeVerification
                )
            ).to.be.eq(true);
        }
    });

    it(`multiple provers, multiple proposers.
    propose blocks, wait til maxNumBlocks is filled.
    proverReward should decline should increase as blocks are proved then verified.
    the provers TKO balance should increase as the blocks are verified and
    they receive the proofReward.
    the proposer should receive a refund on his deposit because he holds a tkoBalance > 0 at time of verification.`, async function () {
        const { maxNumBlocks, commitConfirmations } = await taikoL1.getConfig();

        const proposers = (await createAndSeedWallets(3, l1Signer)).map(
            (p: ethers.Wallet) =>
                new Proposer(
                    taikoL1.connect(p),
                    l2Provider,
                    commitConfirmations.toNumber(),
                    maxNumBlocks.toNumber(),
                    0,
                    p
                )
        );

        const provers = (await createAndSeedWallets(3, l1Signer)).map(
            (p: ethers.Wallet) => new Prover(taikoL1, l2Provider, p)
        );

        for (const prover of provers) {
            await (
                await tkoTokenL1
                    .connect(l1Signer)
                    .mintAnyone(
                        await prover.getSigner().getAddress(),
                        ethers.utils.parseEther("10000")
                    )
            ).wait(1);
        }
        for (const proposer of proposers) {
            await (
                await tkoTokenL1
                    .connect(l1Signer)
                    .mintAnyone(
                        await proposer.getSigner().getAddress(),
                        ethers.utils.parseEther("10000")
                    )
            ).wait(1);
        }

        // prover needs TKO or their reward will be cut down to 1 wei.
        await (
            await tkoTokenL1
                .connect(l1Signer)
                .mintAnyone(
                    await proverSigner.getAddress(),
                    ethers.utils.parseEther("100")
                )
        ).wait(1);

        l2Provider.on(
            "block",
            blockListener(
                chan,
                genesisHeight,
                l2Provider,
                maxNumBlocks.toNumber()
            )
        );

        /* eslint-disable-next-line */
        for await (const blockNumber of chan) {
            const prover = pickRandomElement<Prover>(provers);
            const proposer = pickRandomElement<Proposer>(proposers);
            const proverTkoBalanceBefore = await tkoTokenL1.balanceOf(
                await prover.getSigner().getAddress()
            );

            const proposerTkoBalanceBefore = await tkoTokenL1.balanceOf(
                await proposer.getSigner().getAddress()
            );

            await commitProposeProveAndVerify(
                taikoL1,
                l2Provider,
                blockNumber,
                proposer,
                tkoTokenL1,
                prover
            );

            const proverTkoBalanceAfter = await tkoTokenL1.balanceOf(
                await prover.getSigner().getAddress()
            );

            const proposerTkoBalanceAfter = await tkoTokenL1.balanceOf(
                await proposer.getSigner().getAddress()
            );

            expect(proposerTkoBalanceAfter.lt(proposerTkoBalanceBefore));

            expect(proverTkoBalanceAfter.gt(proverTkoBalanceBefore)).to.be.eq(
                true
            );
        }
    });
});
