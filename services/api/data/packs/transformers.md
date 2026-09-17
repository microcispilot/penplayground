# Tokens and vectors

A language model never sees words. The input sentence is split into tokens, and each token is looked up in an embedding table that turns it into a vector: a list of numbers the model can move around and combine. Six words become six vectors.

Order matters, so a position signal is added to each vector. The same word at a different position produces a different vector, which is how the model can tell "the cat sat" from "sat the cat".

# Queries, keys and values

Attention lets each token look back at the tokens before it and decide how much each one matters. It does this with three learned projections of every vector: a query, a key and a value.

The attention score between two tokens is the dot product of one token's query with the other token's key. High score means "this earlier token is relevant to me right now".

# Scaling by the square root of d

The raw dot products grow with the length of the vectors. Without scaling, the scores become very large, softmax turns into a hard max where one token takes all the weight, and gradients stop flowing during training. Dividing every score by the square root of the key dimension d keeps the scores in a range where softmax stays soft and learning works.

# Softmax and the weighted sum

Softmax turns the scaled scores into weights that are all positive and add up to one. Each token's output is the weighted sum of the value vectors, using those weights. That is the whole attention operation: a query asks, keys answer, values are mixed.

# Multi-head attention

Instead of one attention, the model runs several heads in parallel, typically twelve in a small model. Each head has its own query, key and value projections, so different heads can specialise: one may track subject and verb agreement while another watches punctuation or long-range references. The outputs of all heads are concatenated and projected back to the model dimension.

# Feed-forward layers and residual connections

After attention, each token passes through a small feed-forward network on its own. A residual connection adds the original input vector back to the output of each sub-layer, so information is never lost and very deep stacks can be trained. Layer normalisation keeps the values in a stable range.

# Stacking layers and predicting the next token

One block is attention plus feed-forward with residuals. Stacking that block many times, thirty-two layers in a mid-sized model, gives the transformer. The final vector for the last position is turned into a probability distribution over the vocabulary, and the most likely next token is chosen or sampled. For "the cat sat on the", "mat" wins.

# Masking during generation

During training the model sees whole sequences. During generation each position may only attend to earlier positions; a triangular mask sets the scores for future tokens to negative infinity before softmax, so the model cannot read ahead.

# Common mistake: thinking attention compares words

A common misconception is that attention compares the two words as spelled. It compares the query vector of one token with the key vector of another; both are learned projections of the token's current representation, which already includes position and context from earlier layers.
